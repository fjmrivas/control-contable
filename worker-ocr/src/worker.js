// ============================================================
// Worker: control-contable-ocr
// Recibe un comprobante (imagen o PDF) en base64, lo lee con IA y devuelve
// los campos extraídos como JSON.
//
// Proveedor híbrido para la ruta de factura (POST /): las COMPRAS se leen
// con la API de Anthropic (Claude, de pago) y las VENTAS con la API de
// Gemini (nivel gratuito) — lo decide el campo `tipo` ('compra'|'venta')
// del body, no el frontend directamente. Venta NUNCA usa Claude, bajo
// ningún caso — no hay respaldo entre proveedores. Para compensar (exprimir
// la cuota gratis antes de rendirse), la ruta de venta usa un calendario de
// reintentos más largo que el resto (ESPERAS_MS_GEMINI, ver más abajo). Si
// Gemini agota todos sus reintentos, la extracción simplemente falla como
// cualquier otro error de OCR — el frontend ya sabe mostrar "no se pudo
// leer automáticamente, completa los campos a mano". /estado-cuenta
// (conciliación bancaria) siempre usa Claude, sin excepción — no participa
// de este switch.
//
// No distingue compra/venta para lo que extrae del documento en sí:
// cada comprobante tiene un EMISOR (ruc/razon_social) y normalmente un
// RECEPTOR (ruc_receptor/razon_social_receptor) — el Worker extrae ambos
// tal cual aparecen, sin asumir cuál es "el cliente" del estudio. Esa
// decisión es del frontend:
// - Formulario de compra: el proveedor es el EMISOR (ruc/razon_social).
// - Formulario de venta: el "cliente final" es el RECEPTOR
//   (ruc_receptor/razon_social_receptor) — el emisor ahí es el propio
//   cliente del estudio, no interesa para ese campo.
//
// Protección: solo acepta llamadas con un token de sesión válido
// de Supabase (el mismo access_token del login de Control
// Contable) — así no queda abierto a cualquiera que descubra la
// URL y gaste la cuota de las APIs. No hace falta un secreto
// adicional embebido en el HTML público.
//
// body esperado: { mimeType: string, data: string (base64), tipo?: 'compra'|'venta',
//                  objeto_social?: string (solo compras — activa la alerta de giro) }
// respuesta: { ok: true, data: {...} } | { ok: false, error }
//
// Rutas:
// - POST /              -> extrae un comprobante individual (factura/boleta/etc).
// - POST /estado-cuenta  -> extrae los movimientos de un estado de cuenta
//                           bancario (conciliación bancaria).
//
// JSON estructurado: la API de Anthropic no tiene un "responseSchema"
// nativo como Gemini — el equivalente es "tool use" forzado: se define una
// herramienta con un input_schema (JSON Schema estándar) y se obliga la
// llamada con tool_choice — Claude devuelve el resultado ya como objeto en
// content[].input, sin texto que parsear. Gemini SÍ tiene responseSchema
// nativo, pero espera los `type` en MAYÚSCULAS ('STRING' en vez de
// 'string') — en vez de mantener un segundo schema a mano (con el riesgo
// de que se desincronice del de Claude cada vez que agreguemos un campo),
// el schema de Gemini se genera al vuelo desde el mismo input_schema de
// Claude vía aEsquemaGemini(). El prompt (texto plano) no necesita
// adaptación, es el mismo para ambos proveedores.
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Modelo por defecto — cambiarlo después es tocar esta única constante (o
// setear la env var CLAUDE_MODEL sin redesplegar). Haiku porque esto es
// lectura estructurada de documentos, no una tarea compleja.
const MODELO_POR_DEFECTO = 'claude-haiku-4-5-20251001';
const MODELO_GEMINI_POR_DEFECTO = 'gemini-3.6-flash'; // env var GEMINI_MODEL para cambiarlo sin redesplegar
const MAX_TOKENS = 8192; // generoso a propósito: un estado de cuenta puede traer 75+ movimientos

const PROMPT_FACTURA = `Eres un asistente que extrae datos de comprobantes de pago peruanos (facturas, boletas, recibos por honorarios, notas de crédito/débito) emitidos según el formato de SUNAT, a partir de una imagen o PDF.

Todo comprobante tiene dos partes (RUC) claramente identificadas en el documento:
- El EMISOR: quien emite/factura el comprobante (normalmente arriba, junto al logo/membrete).
- El RECEPTOR: la persona o empresa A QUIEN VA DIRIGIDO el comprobante — el "Señor(es)" / "Cliente" impreso en el documento (normalmente en el bloque de datos del comprador). NO es lo mismo que el emisor — son entidades distintas con RUCs distintos.

Extrae exactamente estos campos:
- ruc: el RUC (11 dígitos) del EMISOR.
- razon_social: la razón social o nombre del EMISOR.
- ruc_receptor: el RUC (11 dígitos) del RECEPTOR, tal como aparece impreso en el documento. Extráelo siempre que el documento lo muestre, sin importar el tipo de comprobante — en Boleta u otros tipos a veces no aparece o el comprador es una persona sin RUC; en ese caso deja "".
- razon_social_receptor: la razón social o nombre del RECEPTOR, mismo criterio que ruc_receptor.
- fecha_emision: la fecha de emisión, en formato YYYY-MM-DD.
- tipo_comprobante: uno de "Factura", "Boleta", "Recibo por honorarios", "Nota de crédito", "Nota de débito", "Recibo por Arrendamiento", "Ticket/Boleta de máquina registradora", "Recibo por Servicios Públicos", "Guía de Remisión", "Comprobante de Retención", "Comprobante de Percepción" u "Otro".
- numero_comprobante: la serie y número del comprobante, tal como aparece (ej. "F001-00123").
- concepto: la descripción del servicio o producto facturado, tal como aparece en el detalle del comprobante. Si hay varias líneas de detalle, resume en una sola frase breve.
- monto_total: el monto total del comprobante (incluye impuestos), como número.
- monto_igv: el monto del IGV discriminado en el comprobante, como número. Usa 0 si no aplica o no se distingue (por ejemplo en un recibo por honorarios).
- monto_retencion: el monto de la retención aplicada, si el documento la muestra (busca palabras como "Retención", "Ret.", "IR:", o un monto entre paréntesis restado del total — típico en un Recibo por Honorarios con retención de renta de 4ta categoría). Usa 0 si no aparece ninguna retención.
- porcentaje_retencion: el porcentaje de esa retención si se indica explícitamente (ej. "8%"). Usa 0 si no aparece.
- moneda: "PEN" si el documento está en soles (símbolo "S/"), o "USD" si está en dólares (símbolo "US$", "USD", "$", o dice "Dólares"). Si no hay ninguna indicación de moneda, asume "PEN" — es lo normal en un comprobante peruano.
- fecha_vencimiento: la fecha de vencimiento o de pago, en formato YYYY-MM-DD, SOLO si el documento la indica explícitamente (ej. "Fecha de vencimiento", "Condición de pago: crédito, vence el..."). La mayoría de comprobantes al contado no la muestran — en ese caso usa "", no repitas la fecha de emisión (eso lo decide quien use este dato, no tú).
- bi_gravada: la base imponible de la parte GRAVADA con IGV (lo que en el comprobante suele aparecer como "Op. Gravada", "Valor de venta" cuando hay IGV, o el monto antes de aplicar el IGV). Usa 0 si el comprobante no tiene ninguna operación gravada (ej. un recibo por honorarios, que no tiene IGV).
- monto_exonerado: la base de operaciones EXONERADAS de IGV, si el comprobante la discrimina explícitamente (busca "Op. Exonerada"). Usa 0 si no aparece.
- monto_inafecto: la base de operaciones INAFECTAS de IGV, si el comprobante la discrimina explícitamente (busca "Op. Inafecta"). Usa 0 si no aparece.
- isc: el Impuesto Selectivo al Consumo, si el comprobante lo discrimina como línea aparte (aplica a combustibles, licores, cigarrillos, vehículos — es poco común). Usa 0 si no aparece.
- icbper: el Impuesto al Consumo de Bolsas de Plástico ("ICBPER", frecuente en boletas de supermercados/retail, normalmente un monto chico como S/0.50 por bolsa). Usa 0 si no aparece.
- tipo_cambio: el tipo de cambio (soles por dólar) SOLO si el propio comprobante lo imprime explícitamente (poco común — la mayoría de comprobantes en USD no lo muestran, en ese caso usa ""). No lo calcules ni lo inventes.
- doc_modificado_fecha_emision, doc_modificado_tipo_cp, doc_modificado_serie, doc_modificado_numero: SOLO cuando tipo_comprobante es "Nota de crédito" o "Nota de débito" — estos documentos SIEMPRE referencian el comprobante original que modifican (es obligatorio por ley que lo impriman, busca "Documento que modifica", "Comprobante afectado", o similar). doc_modificado_tipo_cp usa el mismo criterio de tipo_comprobante (ej. "Factura", "Boleta"). doc_modificado_serie y doc_modificado_numero son la serie y número del documento original, por separado (no juntos como en numero_comprobante). Para cualquier otro tipo de comprobante, deja los 4 campos en "".

No confundas emisor con receptor bajo ninguna circunstancia — son los dos RUCs más importantes del documento y deben quedar en los campos correctos. Si algún dato no aparece o no puedes leerlo con certeza, usa una cadena vacía "" (para texto) o 0 (para números). No inventes datos.`;

const HERRAMIENTA_FACTURA = {
  name: 'extraer_datos_comprobante',
  description: 'Registra los datos extraídos de un comprobante de pago peruano (factura, boleta, recibo por honorarios, etc.)',
  input_schema: {
    type: 'object',
    properties: {
      ruc: { type: 'string' },
      razon_social: { type: 'string' },
      ruc_receptor: { type: 'string' },
      razon_social_receptor: { type: 'string' },
      fecha_emision: { type: 'string' },
      tipo_comprobante: {
        type: 'string',
        enum: ['Factura', 'Boleta', 'Recibo por honorarios', 'Nota de crédito', 'Nota de débito', 'Recibo por Arrendamiento', 'Ticket/Boleta de máquina registradora', 'Recibo por Servicios Públicos', 'Guía de Remisión', 'Comprobante de Retención', 'Comprobante de Percepción', 'Otro']
      },
      numero_comprobante: { type: 'string' },
      concepto: { type: 'string' },
      monto_total: { type: 'number' },
      monto_igv: { type: 'number' },
      monto_retencion: { type: 'number' },
      porcentaje_retencion: { type: 'number' },
      moneda: { type: 'string', enum: ['PEN', 'USD'] },
      fecha_vencimiento: { type: 'string' },
      bi_gravada: { type: 'number' },
      monto_exonerado: { type: 'number' },
      monto_inafecto: { type: 'number' },
      isc: { type: 'number' },
      icbper: { type: 'number' },
      tipo_cambio: { type: 'string' },
      doc_modificado_fecha_emision: { type: 'string' },
      doc_modificado_tipo_cp: { type: 'string' },
      doc_modificado_serie: { type: 'string' },
      doc_modificado_numero: { type: 'string' }
    },
    required: ['ruc', 'razon_social', 'ruc_receptor', 'razon_social_receptor', 'fecha_emision', 'tipo_comprobante', 'numero_comprobante', 'concepto', 'monto_total', 'monto_igv', 'monto_retencion', 'porcentaje_retencion', 'moneda', 'fecha_vencimiento', 'bi_gravada', 'monto_exonerado', 'monto_inafecto', 'isc', 'icbper', 'tipo_cambio', 'doc_modificado_fecha_emision', 'doc_modificado_tipo_cp', 'doc_modificado_serie', 'doc_modificado_numero']
  }
};

// ------------------------------------------------------------------
// Alerta de giro de negocio (solo COMPRAS, y solo si el cliente tiene
// objeto_social cargado): se evalúa en la MISMA llamada del OCR — un bloque de
// prompt extra + 2 campos extra en el schema, sin llamada adicional. Aviso no
// bloqueante para detectar gastos no deducibles antes de una fiscalización.
// El bloque está calibrado contra falsos positivos a propósito: un aviso que
// salta seguido termina ignorándose por costumbre, así que por defecto NO marca.
// ------------------------------------------------------------------
const MAX_OBJETO_SOCIAL = 1000;

function bloqueGiroNegocio(objetoSocial) {
  return `

EVALUACIÓN DE GIRO DE NEGOCIO (campos alerta_giro_negocio y alerta_giro_negocio_motivo):
El comprobante es una COMPRA (gasto) de una empresa cuyo giro / objeto social declarado es:
"""
${objetoSocial}
"""
Evalúa si este gasto parece NO estar vinculado a esa actividad — sería un gasto probablemente no deducible ante una fiscalización de SUNAT. Sé conservador: un aviso que salta seguido termina ignorándose, así que por defecto NO marques.
- Marca alerta_giro_negocio=true SOLO si el gasto es CLARAMENTE ajeno al giro Y no se te ocurre una justificación empresarial plausible.
- NUNCA marques (false) los gastos generales que casi toda empresa tiene, sea cual sea su giro: servicios básicos (luz, agua, gas), internet y telefonía, alquiler de oficina o local, útiles y equipos de oficina, servicios contables, legales o de consultoría, software y suscripciones, seguros, comisiones y servicios bancarios, mantenimiento y limpieza, publicidad y marketing, capacitación, transporte, movilidad y combustible, tributos y tasas.
- SÍ marca (true) el consumo claramente personal o doméstico (abarrotes y menaje del hogar, electrodomésticos de cocina, ropa personal, farmacia de uso personal, entretenimiento, colegios, viajes turísticos) y los insumos, maquinaria o bienes de capital de un rubro totalmente distinto al declarado.
- Evalúa contra el documento completo (quién lo emite y las líneas de detalle), no solo contra el campo "concepto", que es un resumen de una frase.
- Si no se puede evaluar (el detalle es genérico como "varios" o "consumo", o es ilegible), usa false — no adivines.
- Si marcas true, alerta_giro_negocio_motivo es UNA sola frase en español, neutral y sin acusar, que explique por qué parece ajeno citando el giro declarado. Si marcas false, alerta_giro_negocio_motivo es "".
Ejemplos (giro: "Representación artística y producción de espectáculos"):
- Recibo de luz del local → false (gasto general).
- Alquiler de sonido e iluminación para un evento → false (vinculado al giro).
- Compra de una cocina a gas y una refrigeradora en una tienda de electrodomésticos → true, motivo: "Parece un artículo de uso doméstico; el giro declarado es representación artística y producción de espectáculos."
- Boleta de supermercado con detalle genérico → false (no se puede evaluar).`;
}

function herramientaConGiro(herramienta) {
  return {
    ...herramienta,
    input_schema: {
      ...herramienta.input_schema,
      properties: {
        ...herramienta.input_schema.properties,
        alerta_giro_negocio: { type: 'boolean' },
        alerta_giro_negocio_motivo: { type: 'string' }
      },
      required: [...herramienta.input_schema.required, 'alerta_giro_negocio', 'alerta_giro_negocio_motivo']
    }
  };
}

// ------------------------------------------------------------------
// Conciliación bancaria: extrae los movimientos de un estado de cuenta
// bancario (PDF, normalmente varias páginas) en vez de un comprobante
// individual. Ruta separada porque el prompt/herramienta no tienen nada
// que ver con una factura.
// ------------------------------------------------------------------
const PROMPT_ESTADO_CUENTA = `Eres un asistente que extrae movimientos de un estado de cuenta bancario peruano (PDF), a partir de una imagen o PDF que puede tener varias páginas.

Extrae:
- banco: el nombre del banco que emite el estado de cuenta (ej. "BCP", "Interbank", "BBVA", "Scotiabank", "Banco de la Nación", "Banco Pichincha"), normalmente visible en el logo o membrete. Solo si estás razonablemente seguro — usa "" si no lo puedes identificar con confianza, no adivines.
- periodo_inicio: la fecha de inicio del período que cubre el estado de cuenta (YYYY-MM-DD). Si el documento indica el período como un rango explícito de fechas, usa la fecha de inicio tal cual. Si en cambio lo indica como un mes y año (ej. "Enero 2026", "Estado de cuenta de 01/2026"), calcula el primer día de ese mes. Usa "" solo si no hay ninguna indicación de período en el documento.
- periodo_fin: la fecha de fin del período (YYYY-MM-DD). Mismo criterio que periodo_inicio — si el documento solo indica un mes y año, calcula el último día de ese mes. Usa "" solo si no hay ninguna indicación de período.
- movimientos: la lista de TODOS los movimientos (abonos y cargos) que aparecen en el detalle del documento, cada uno con:
  - fecha: fecha del movimiento (YYYY-MM-DD). IMPORTANTE: los estados de cuenta bancarios peruanos casi siempre muestran cada línea de movimiento SOLO con día y mes (ej. "13/05"), sin repetir el año — el año casi nunca aparece en cada fila individual. Cuando la línea del movimiento no trae año explícito, NO lo adivines ni asumas un año por defecto: usa el año que corresponde según periodo_inicio/periodo_fin de este mismo documento (calculados arriba). Si el período cruza un cambio de año (ej. de diciembre a enero), usa el año que le corresponda al mes de ese movimiento específico — diciembre toma el año de periodo_inicio, enero toma el año de periodo_fin. Solo si no hay absolutamente ninguna pista de año en todo el documento (ni en el período, ni en ningún encabezado), usa tu mejor estimación — esto debería ser muy poco común.
  - monto: el monto del movimiento, SIEMPRE como número positivo (el signo/dirección va en "tipo", nunca en el monto).
  - moneda: "PEN" si la cuenta/columna está en soles (símbolo "S/"), o "USD" si está en dólares (símbolo "US$", "USD" o "$").
  - tipo: "abono" si es dinero que ENTRA a la cuenta (depósito, transferencia recibida, abono, etc.) o "cargo" si es dinero que SALE (pago, transferencia enviada, comisión, cargo, etc.).
  - descripcion: la glosa/descripción del movimiento tal como aparece (ej. "TRANSF INTERBANCARIA - JUAN PEREZ").

No te saltes movimientos ni los resumas — extrae cada línea individual del detalle. Ignora saldos de apertura/cierre y totales, solo interesan los movimientos individuales. Si no puedes leer con certeza algún campo de un movimiento, usa tu mejor estimación razonable; no inventes movimientos que no existen en el documento.`;

const HERRAMIENTA_ESTADO_CUENTA = {
  name: 'extraer_movimientos_estado_cuenta',
  description: 'Registra el banco, el período y los movimientos individuales extraídos de un estado de cuenta bancario peruano.',
  input_schema: {
    type: 'object',
    properties: {
      banco: { type: 'string' },
      periodo_inicio: { type: 'string' },
      periodo_fin: { type: 'string' },
      movimientos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            fecha: { type: 'string' },
            monto: { type: 'number' },
            moneda: { type: 'string', enum: ['PEN', 'USD'] },
            tipo: { type: 'string', enum: ['abono', 'cargo'] },
            descripcion: { type: 'string' }
          },
          required: ['fecha', 'monto', 'moneda', 'tipo', 'descripcion']
        }
      }
    },
    required: ['banco', 'periodo_inicio', 'periodo_fin', 'movimientos']
  }
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

// Códigos HTTP transitorios (saturación/rate-limit) que vale la pena
// reintentar — no confundir con errores "de verdad" (archivo corrupto,
// prompt inválido, etc.), esos siguen fallando rápido sin reintentar.
// Set único para ambos proveedores: 529 es específico de Anthropic
// ("Overloaded") y 504 más típico de Gemini — incluir el código "ajeno" en
// cada llamada es inofensivo, simplemente nunca se dispara.
const CODIGOS_REINTENTABLES = new Set([429, 500, 502, 503, 504, 529]);
const ESPERAS_MS = [1000, 2000]; // Claude/estado-cuenta: backoff 1s, 2s (2 reintentos = 3 intentos en total)
// Venta (Gemini) no tiene respaldo a otro proveedor, así que vale la pena
// exprimir mejor la cuota gratis antes de rendirse — mismo backoff
// progresivo (duplicando cada vez), pero con más pasos: 1s,2s,4s,8s
// (4 reintentos = 5 intentos en total).
const ESPERAS_MS_GEMINI = [1000, 2000, 4000, 8000];

// Reintentos genéricos, sin nada específico de un proveedor — cada llamador
// arma su propia URL/headers/body y le pasa un nombre (para el mensaje de
// error) y su propio calendario de esperas.
async function llamarConReintentos(nombreProveedor, url, fetchOptions, esperasMs = ESPERAS_MS) {
  let intento = 0;
  while (true) {
    let resp;
    try {
      resp = await fetch(url, fetchOptions);
    } catch (e) {
      // Fallo de red al contactar al proveedor (DNS/conexión) — no es el
      // caso de saturación que pide reintento, falla rápido igual que antes.
      throw { mensaje: `No se pudo contactar a ${nombreProveedor}: ` + e.message };
    }

    if (resp.ok) return resp;

    const puedeReintentar = CODIGOS_REINTENTABLES.has(resp.status) && intento < esperasMs.length;
    if (!puedeReintentar) {
      const errText = await resp.text();
      throw { mensaje: `${nombreProveedor} respondió con error: ` + errText };
    }

    await new Promise(r => setTimeout(r, esperasMs[intento]));
    intento++;
  }
}

// Arma el bloque de contenido multimodal correcto según el tipo de archivo
// — a diferencia del inlineData genérico de Gemini, la API de Anthropic
// distingue explícitamente entre imágenes (type:'image') y PDFs
// (type:'document').
function bloqueArchivo(mimeType, data) {
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mimeType, data } };
}

// Llama a Claude con tool use forzado (el equivalente de Anthropic al
// responseSchema de Gemini) y devuelve directamente el objeto ya
// estructurado — Claude lo entrega en content[].input, no como texto que
// haya que parsear.
async function extraerConClaude(env, { prompt, herramienta, mimeType, data }) {
  const modelo = env.CLAUDE_MODEL || MODELO_POR_DEFECTO;
  const url = 'https://api.anthropic.com/v1/messages';
  const body = {
    model: modelo,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        bloqueArchivo(mimeType, data)
      ]
    }],
    tools: [herramienta],
    tool_choice: { type: 'tool', name: herramienta.name }
  };

  const resp = await llamarConReintentos('Claude', url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const claudeJson = await resp.json();
  const bloqueHerramienta = (claudeJson.content || []).find(b => b.type === 'tool_use');
  if (!bloqueHerramienta) {
    throw { mensaje: 'Claude no devolvió datos estructurados (posible bloqueo de contenido o archivo ilegible)' };
  }
  return bloqueHerramienta.input;
}

// Convierte un JSON Schema al estilo Claude (type: 'string'/'object'/...) al
// responseSchema que espera Gemini (type: 'STRING'/'OBJECT'/... en
// mayúsculas) — recorre properties/items recursivamente y deja todo lo
// demás (enum, required, description) intacto. Así el schema de Gemini se
// genera al vuelo desde el input_schema de Claude en vez de mantenerse a
// mano por separado: no hay forma de que se desincronicen.
function aEsquemaGemini(schema) {
  if (Array.isArray(schema)) return schema.map(aEsquemaGemini);
  if (schema && typeof schema === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
      out[k] = (k === 'type' && typeof v === 'string') ? v.toUpperCase() : aEsquemaGemini(v);
    }
    return out;
  }
  return schema;
}

// Llama a Gemini con responseSchema (su equivalente nativo al tool use
// forzado de Claude) y devuelve el objeto ya parseado — a diferencia de
// Claude, Gemini entrega el JSON como texto dentro de la respuesta, no como
// un bloque estructurado aparte.
async function extraerConGemini(env, { prompt, herramienta, mimeType, data }) {
  const modelo = env.GEMINI_MODEL || MODELO_GEMINI_POR_DEFECTO;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: aEsquemaGemini(herramienta.input_schema)
    }
  };

  const resp = await llamarConReintentos('Gemini', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, ESPERAS_MS_GEMINI);
  const geminiJson = await resp.json();
  const textoRespuesta = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textoRespuesta) {
    throw { mensaje: 'Gemini no devolvió datos legibles (posible bloqueo de contenido o archivo ilegible)' };
  }
  try {
    return JSON.parse(textoRespuesta);
  } catch (e) {
    throw { mensaje: 'La respuesta de Gemini no fue un JSON válido' };
  }
}

// ------------------------------------------------------------------
// Tipo de cambio oficial SUNAT: NO se consulta automáticamente desde este
// Worker. Se intentó con Browser Rendering (Puppeteer real, vía un binding
// MYBROWSER que ya no existe) para esquivar el reCAPTCHA v3 + WAF de
// e-consulta.sunat.gob.pe, pero se confirmó con logs reales de producción
// (wrangler tail) que SUNAT bloquea a nivel de red las conexiones desde los
// datacenters de Cloudflare Browser Rendering — net::ERR_CONNECTION_RESET
// consistente en cada intento, mientras una prueba aislada hacia otro sitio
// externo (example.com) funcionó bien desde la misma infraestructura. Es un
// bloqueo de IP/firewall permanente, no arreglable con reintentos ni con más
// paciencia. Se abandonó esa vía — la sección "Tipo de Cambio" del frontend
// ahora solo se llena subiendo el reporte mensual en PDF (SUNAT sí sirve ese
// PDF a un navegador humano normal, distinto problema) o a mano.
// ------------------------------------------------------------------

async function esUsuarioValido(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  try {
    const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY }
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Método no permitido' }, 405);
    }
    if (!(await esUsuarioValido(request, env))) {
      return jsonResponse({ ok: false, error: 'No autorizado' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, error: 'JSON inválido' }, 400);
    }

    const { mimeType, data, tipo, objeto_social } = body || {};
    if (!mimeType || !data) {
      return jsonResponse({ ok: false, error: 'Faltan mimeType o data (base64) del archivo' }, 400);
    }

    const esEstadoCuenta = new URL(request.url).pathname === '/estado-cuenta';
    let prompt = esEstadoCuenta ? PROMPT_ESTADO_CUENTA : PROMPT_FACTURA;
    let herramienta = esEstadoCuenta ? HERRAMIENTA_ESTADO_CUENTA : HERRAMIENTA_FACTURA;

    // Alerta de giro: solo compras con objeto_social no vacío — cualquier otro
    // caso (ventas, estado de cuenta, cliente sin giro cargado) queda idéntico.
    const objetoSocial = typeof objeto_social === 'string' ? objeto_social.trim().slice(0, MAX_OBJETO_SOCIAL) : '';
    if (!esEstadoCuenta && tipo === 'compra' && objetoSocial) {
      prompt += bloqueGiroNegocio(objetoSocial);
      herramienta = herramientaConGiro(herramienta);
    }

    // Solo la ruta de factura distingue proveedor por tipo de operación —
    // compra usa Claude, venta usa Gemini, sin respaldo entre uno y otro
    // bajo ningún caso. /estado-cuenta ignora `tipo` y siempre usa Claude.
    const usarGemini = !esEstadoCuenta && tipo === 'venta';
    if (usarGemini) {
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ ok: false, error: 'Falta configurar el secret GEMINI_API_KEY en el Worker' }, 500);
      }
    } else if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ ok: false, error: 'Falta configurar el secret ANTHROPIC_API_KEY en el Worker' }, 500);
    }

    let datos;
    try {
      datos = usarGemini
        ? await extraerConGemini(env, { prompt, herramienta, mimeType, data })
        : await extraerConClaude(env, { prompt, herramienta, mimeType, data });
    } catch (e) {
      // Si Gemini agota todos sus reintentos (ESPERAS_MS_GEMINI), esto
      // también captura ese caso — venta no tiene a qué proveedor caer, así
      // que falla igual que cualquier otro error de OCR. El frontend ya
      // sabe mostrar "no se pudo leer automáticamente, completa los campos
      // a mano" para cualquier error de esta ruta.
      return jsonResponse({ ok: false, error: e.mensaje }, 502);
    }

    return jsonResponse({ ok: true, data: datos });
  }
};
