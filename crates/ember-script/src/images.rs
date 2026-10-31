//! image.c's primitives for scripts ([ADR 0046]): image specs are lists, as
//! Emacs's are, `[Symbol.for("image"), Symbol.for(":type"), ...]`.
//!
//! [ADR 0046]: ../../../docs/adr/0046-images.md

use rquickjs::{Ctx, Function, Object, Value};

use super::{value_from_js, value_to_js, with_editor};

pub(crate) fn image_functions<'js>(ctx: &Ctx<'js>, native: &Object<'js>) -> rquickjs::Result<()> {
    native.set(
        "imagep",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, spec: Value<'js>| -> rquickjs::Result<bool> {
            let spec = value_from_js(&ctx, spec)?;
            Ok(ember_core::image::valid_image_p(&spec))
        })?,
    )?;
    native.set(
        "imageSize",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, spec: Value<'js>, pixels: bool| -> rquickjs::Result<Vec<f64>> {
            let spec = value_from_js(&ctx, spec)?;
            with_editor(&ctx, |ed| ed.image_size(&spec, pixels).map(|(w, h)| vec![w, h]))
        })?,
    )?;
    native.set(
        "imageMaskP",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, spec: Value<'js>| -> rquickjs::Result<bool> {
            let spec = value_from_js(&ctx, spec)?;
            with_editor(&ctx, |ed| ed.image_mask_p(&spec))
        })?,
    )?;
    native.set(
        "imageMetadata",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, spec: Value<'js>| -> rquickjs::Result<Value<'js>> {
            let spec = value_from_js(&ctx, spec)?;
            let data = with_editor(&ctx, |ed| ed.image_metadata(&spec))?;
            value_to_js(&ctx, &data)
        })?,
    )?;
    native.set(
        "imageFlush",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, spec: Value<'js>| -> rquickjs::Result<()> {
            let spec = value_from_js(&ctx, spec)?;
            with_editor(&ctx, |ed| ed.image_flush(&spec))
        })?,
    )?;
    native.set(
        "clearImageCache",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, filter: Value<'js>| -> rquickjs::Result<()> {
            let filter = value_from_js(&ctx, filter)?;
            with_editor(&ctx, |ed| ed.clear_image_cache(&filter))
        })?,
    )?;
    native.set(
        "imageTransformsP",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.image_transforms().into_iter().map(String::from).collect::<Vec<_>>())))?,
    )?;
    native.set("imageCacheSize", Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.image_cache_size() as f64)))?)?;
    native.set(
        "initImageLibrary",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, kind: String| with_editor(&ctx, |ed| Ok(ed.init_image_library(&kind))))?,
    )?;
    native.set("imagesShown", Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.images_shown())))?)?;
    Ok(())
}
