# Vendored fonts for software-made share previews (OG images)

Used ONLY by `server/src/comic/publication/ogImage.ts` (sharp + Pango/HarfBuzz) to letter the
1200×630 link-preview card of a published comic. No AI, no network at runtime. The container
image copies this folder to `/usr/local/share/fonts/dreamstream` and runs `fc-cache`
(`Dockerfile.cloudflare`); the build fails if Devanagari + Latin text does not render.

Licence: every file is SIL Open Font License 1.1 (`OFL.txt` is the licence text; the
per-family copyright notices are in `OFL-Bangers.txt` and `OFL-Noto.txt`). OFL allows
bundling and embedding in software; the fonts are not sold on their own.

Provenance (downloaded 2026-10-22, pinned commits):
- Bangers: `https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/bangers/`
- Noto: `https://raw.githubusercontent.com/notofonts/notofonts.github.io/957448b6168f09dca2c8005449e9b6f3fd2dd207/fonts/<Family>/unhinted/ttf/`
  (static, unhinted TTF builds; Pango does its own hinting/AA)

CJK (Japanese, Korean, Chinese) is phase 2 (≈ 15–20 MB); until then a CJK title is drawn
in the source language on the image while `og:title` still carries the translation, so a
preview never shows tofu boxes. Inter was replaced by Noto Sans SemiBold/Bold (same metrics
class, one family for Latin/Greek/Cyrillic, keeps the image lean).

| File | Family (fontconfig) | Style | Bytes | SHA-256 |
|---|---|---|---|---|
| Bangers-Regular.ttf | Bangers | Regular | 93148 | 4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824 |
| NotoSans-Bold.ttf | Noto Sans | Bold | 432376 | 87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9 |
| NotoSans-SemiBold.ttf | Noto Sans | SemiBold | 431500 | a7af8d4a11e8e49fea9a19786a6469210b512cd4061413e8036bdd2425722795 |
| NotoSansArabic-Bold.ttf | Noto Sans Arabic | Bold | 141852 | f4cb79f842a07d1bcf597879574358fb7010f73761396d1d0f2445dfedb4d2ca |
| NotoSansBengali-Bold.ttf | Noto Sans Bengali | Bold | 102440 | 2fe8d779e0f19576d1fc11e39f9154b4326a17b693215017dd1f5a8898c3f2c3 |
| NotoSansDevanagari-Bold.ttf | Noto Sans Devanagari | Bold | 183412 | ff2f76a23aad41e0608c2d7dbc4bacd247ff3bec78f0ec2a8fb106b561636e58 |
| NotoSansGujarati-Bold.ttf | Noto Sans Gujarati | Bold | 140812 | 3ce0cf6e1d0bfe2ef5823772eeb2f25da28ec0c2c1d99c0fce529025723e61a1 |
| NotoSansGurmukhi-Bold.ttf | Noto Sans Gurmukhi | Bold | 35712 | d16804da302ecb2a7defe0502e65136870445fd88f9fddaef60b68d5f1ee7386 |
| NotoSansKannada-Bold.ttf | Noto Sans Kannada | Bold | 133868 | e989c72f6fec5a0b3366af5f90e3ce8b2b8a350fc5286c6374f0353937e513f5 |
| NotoSansMalayalam-Bold.ttf | Noto Sans Malayalam | Bold | 75916 | 165d635d82b0eb0a04275b92b9334c1ece679b99f263727c24c7c92ebcab51e9 |
| NotoSansTamil-Bold.ttf | Noto Sans Tamil | Bold | 46428 | 04a472e49fa83b387976756554fe179de631a950d79f652ebba14a39a44f5d71 |
| NotoSansTelugu-Bold.ttf | Noto Sans Telugu | Bold | 165564 | 44393b05a863057cc2cbfe86623fc20b906b00cf19a2ae9304cdd0f3608889db |

Verify: `cd server/assets/fonts && sha256sum *.ttf` must match the table. Total ≈ 2 MB.
