-- ============================================================================
-- Alerta (no bloqueante) de gasto posiblemente no vinculado al giro del negocio.
--
-- clientes.objeto_social: descripción libre de las actividades comerciales del
-- cliente. Se envía al Worker de OCR al leer una factura de COMPRA con IA, para
-- que el modelo evalúe (en la misma llamada, sin costo extra) si el concepto
-- parece ajeno al giro — evita gastos no deducibles que luego generan
-- observaciones en una fiscalización de SUNAT.
--
-- comprobantes_compra.alerta_giro_negocio / _motivo: resultado de esa
-- evaluación, guardado desde la respuesta del OCR. Es solo un aviso: no
-- bloquea el guardado ni cambia el estado del comprobante.
-- ============================================================================

alter table clientes
  add column if not exists objeto_social text;

alter table comprobantes_compra
  add column if not exists alerta_giro_negocio boolean not null default false,
  add column if not exists alerta_giro_negocio_motivo text;
