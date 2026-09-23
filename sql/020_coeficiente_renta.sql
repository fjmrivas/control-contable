-- ============================================================================
-- Coeficiente de Renta (declaración anual anterior) — usado por el KPI de IGV
-- y pago a cuenta de Renta: Régimen General (y RMT una vez que supera las 300
-- UIT del año) paga el MAYOR entre este coeficiente y 1.5% de ingresos netos
-- mensuales. Se guarda como fracción decimal (ej. 0.0125), igual como SUNAT lo
-- reporta en la DJ Anual — no como porcentaje. Vacío por defecto: sin él, el
-- KPI simplemente usa 1.5%.
-- ============================================================================

alter table clientes
  add column if not exists coeficiente_renta numeric;
