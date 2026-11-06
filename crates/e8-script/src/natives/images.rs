//! image.c's primitives for scripts ([ADR 0046]): image specs are lists, as
//! Emacs's are, `[Symbol.for("image"), Symbol.for(":type"), ...]`.
//!
//! [ADR 0046]: ../../../../docs/adr/0046-images.md

use crate::natives::natives;
use crate::*;

natives! {
    fn imageTransformsP(ed) -> Vec<String> {
        Ok(ed.image_transforms().into_iter().map(String::from).collect::<Vec<_>>())
    }

    /// How many bytes the decoded images take, as image-cache-size.
    pub fn imageCacheSize(ed) -> f64 {
        Ok(ed.image_cache_size() as f64)
    }

    fn initImageLibrary(ed, kind: String) -> bool {
        Ok(ed.init_image_library(&kind))
    }

    fn imagesShown(ed) -> bool {
        Ok(ed.images_shown())
    }

    /// Whether a value is an image spec E8 can show, as imagep: `(image :type TYPE :file FILE ...)` as a list of symbols and values.
    pub fn imagep(ed, spec: EditorValue) -> bool {
        Ok(e8_core::image::valid_image_p(&spec))
    }

    fn imageSize(ed, spec: EditorValue, pixels: bool) -> Vec<f64> {
        ed.image_size(&spec, pixels).map(|(w, h)| vec![w, h])
    }

    /// Whether an image has a mask, as image-mask-p.
    pub fn imageMaskP(ed, spec: EditorValue) -> bool {
        ed.image_mask_p(&spec)
    }

    fn imageMetadata(ed, spec: EditorValue) -> EditorValue {
        ed.image_metadata(&spec)
    }

    /// Forget an image, so it is read again when next shown, as image-flush.
    pub fn imageFlush(ed, spec: EditorValue) {
        ed.image_flush(&spec)
    }

    /// Forget every image, or those of a file name, as clear-image-cache.
    #[ts = "(filter?: Value): void"]
    pub fn clearImageCache(ed, filter: EditorValue) {
        ed.clear_image_cache(&filter)
    }
}
