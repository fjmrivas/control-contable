-- ============================================================================
-- Dirección del cliente — necesaria para el encabezado del Libro de
-- Compras/Ventas clásico (Registro de Ventas/Compras para archivar), que
-- exige razón social + RUC + dirección en la cabecera. No existía en ningún
-- lugar del sistema hasta ahora. Opcional: si queda vacía, esa línea del
-- encabezado simplemente se omite al generar el Excel.
-- ============================================================================

alter table clientes
  add column if not exists direccion text;
