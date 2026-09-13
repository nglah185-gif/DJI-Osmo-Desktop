# Preview Source Audit V2

Browse resolves `MediaAsset.preview` only and labels it `LRF_PROXY`; it never falls back to Original when a preview exists. Edit resolves `MediaAsset.original` and labels it `ORIGINAL`. The preview header exposes mode, source filename, and source type for runtime inspection.
