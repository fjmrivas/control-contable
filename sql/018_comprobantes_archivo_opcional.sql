-- ============================================================================
-- Permite comprobantes de compra/venta SIN archivo adjunto — necesario para la
-- carga masiva desde Excel (migrar historial, o un Excel que ya arma un
-- cliente): esos comprobantes no pasan por el flujo de subir foto/PDF + OCR,
-- así que archivo_url queda vacío hasta que alguien lo adjunte editando el
-- comprobante individualmente. El formulario de subida individual (con OCR)
-- sigue exigiendo un archivo en la UI — este cambio solo habilita la
-- excepción a nivel de base de datos para la carga masiva.
-- ============================================================================

alter table comprobantes_compra alter column archivo_url drop not null;
alter table comprobantes_venta alter column archivo_url drop not null;
