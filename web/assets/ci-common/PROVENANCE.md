# CI-Common brand bundle provenance

This directory is a checked-in, hash-verified subset of the published
`@companionintelligence/tokens@1.6.0` brand bundle from CI-Common.

| Item | Value |
| --- | --- |
| Source repository | `https://github.com/companionintelligence/CI-Common` |
| Release | `@companionintelligence/tokens@1.6.0` |
| Bundle | `ci-brand-1.6.0.tar.gz` |
| Bundle SHA-256 | `c863698f909deb848ba7ef2cde42858f7f325da9e90900130efe1d0cbdb05021` |
| Consumed files | `tokens.css`, `tokens.json`, canonical mark/wordmark, Manrope, JetBrains Mono, Archivo Black |

The bundle is vendored so the loopback wizard works offline and on a new
machine without a sibling CI-Common checkout. Do not hand-edit generated
token files. Refresh them from a published CI-Common brand bundle, verify the
release checksum, update this document, and rerun `npm run build` plus
`./bin/agentctl check`.
