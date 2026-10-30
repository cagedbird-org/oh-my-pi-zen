Generate or edit images using the configured `image` role and its ordered fallback chain. Returned files are saved under the system temporary directory with unique names; copy them elsewhere when needed. No model selector or output directory is accepted.

<instruction>
- Write one natural-language `prompt`. Start with the finished artifact and intended use, then describe the subject, composition and visible details: materials, lighting, palette and medium. Split complex requirements into short labeled paragraphs.
- Put exact visible text in quotation marks, specify its placement and typeface, and request no additional text. Ask for sharp, legible, correctly spelled lettering.
- For editing, say “Only change X” and list what must remain unchanged (identity, pose, layout, colors, lettering, etc.).
- Supply local reference paths in `input`. Number them in the prompt (Image 1, Image 2, …) and explain each reference's purpose, such as composition, character identity or material.
- Set canvas dimensions through `size` (square, landscape, portrait, or WIDTHxHEIGHT), not the prompt. Set `quality` through its parameter (default high).
- For game sprites, icons, cutouts and reusable assets, set `background: "transparent"`. Background is a parameter, not a prompting trick; transparent output uses PNG. Opaque and auto are also supported.
- `count` is 1–4 (default 1). Multiple images are generated with parallel single-image requests.
- Servers may change size or quality. Trust the actual output dimensions and provider-reported quality in the result, not the requested values. Unreported quality is explicitly labeled.
- Failover results name the successful model and earlier failures. Configure image models in models.yml with `api: openai-images` under the existing provider to reuse its credentials and headers, then select them with the image role and retry.fallbackChains.image. Codex OAuth image models can share that chain without sharing credentials.
</instruction>
