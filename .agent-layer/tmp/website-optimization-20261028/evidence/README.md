# Agent Outbox performance and preservation evidence

[Open the before/after gallery](index.html). Original PNGs and strict pixel diffs/overlays cover 20 matched page/state pairs at desktop 1440×1000 DPR1, mobile 390×844 DPR3, plus 1024/768 widths. **Zero differing pixels across 90,323,632 compared pixels; maximum channel delta 0.** Full pages, top view, menu, pricing, CTA hover, fixture signup and docs states are included.

| Three-run matched local median | Base | Candidate |
| --- | ---: | ---: |
| First-viewport LCP | 2.816 s | 2.084 s |
| Onload | 3.529 s | 3.206 s |
| Full-scroll asset completion | 3.302 s | 2.980 s |
| CDP browser transfer (including headers/prefetch) | 602,765 B | 539,152 B |
| Resource Timing encoded body bytes | 586,107 B | 522,498 B |

Mobile encounters both phone and tablet PNGs: their combined source bytes fall 244,445 → 180,847 (63,598 B saved). Actual median-run PNG browser transfers including headers fall 245,359 → 181,760 B. Desktop can encounter all three PNGs; total source bytes fall 489,663 → 372,486 (117,177 B / 23.93%). Both responsive product compositions remain.

## Method and limits

Base e0aebb42f05004babdeb60b07ca2cb356f66cb6b; measured implementation commit 6d0cbc638a4852999137d56ab27606c533eb88c4. Both use the same installed pinned dependencies and Node 24.18.0, optimized Next production-mode builds with the repository-supported loopback fixture configuration. Same HTTP/1.1 host/port, Chromium 156.0.8078.73, 390×844 DPR3 touch/mobile contexts, CDP 200,000 B/s down, 93,750 B/s up, 150 ms latency, CPU 4×. Fresh empty contexts/cache each run, baseline three then candidate three. No authentication profile reused.

First-viewport LCP is collected before scrolling/input, with image decode and font completion verified. Scroll from top to document bottom in 633 CSS px steps every 150 ms; no tab changes. Full-scroll asset completion is the latest navigation-relative responseEnd of img/css/link/script assets discovered through the pass, plus document responseEnd. This covers all encountered images, CSS, scripts and fonts, excludes route-data prefetch, favicon and idle verification after loading, and is recorded separately from onload and scan end. All homepage images are eager; full scroll discovers no additional image URL backgrounds or external fonts. Every image decoded, fonts reached ready, no request/page errors occurred. Raw request records, Resource Timing and scan end times are retained.

The shared workload lock excluded other owners' heavy builds/benchmarks. Background host activity remained: baseline-start load 5.20 with brief gog/Claude CPU spikes; candidate-start load 4.15 and lower competing CPU. Three-run LCP ranges were 2.816–2.832 s and 2.076–2.088 s. Raw local host snapshots remain in the task-local logs. These local estimates exclude hosted Clerk/Sentry traffic and edge latency. They are **not an absolute live timing prediction or guarantee**.

The separate original live reference is v0.7.1 / 5f4a44915f2ccffe5c83f55ed203882e9fc5ee49: mobile median LCP 5.34 s, onload 7.55 s; one separate full-scroll pass 8.72 s. Do not subtract local savings from those hosted values to promise release timings.

## Preservation and reproducibility

Functional inspection matched page text/links/image geometry, menu open/Escape/focus return, pricing anchor/menu close, signup CTA navigation to the existing deterministic fixture and docs headings. Real authenticated Clerk signup was not exercised. No runtime/auth/analytics/logging/error/cache source changed. Font loading, fixed identical release metadata and completed natural finite transitions stabilize the captures. No masks, hidden elements, CSS changes or nonzero tolerance were used. No homepage animation was observed to require phase alignment.

- [Measurement summary and complete method](measurement-summary.json)
- [Strict visual comparisons](visual-diffs.json)
- [Source PNG pixel/header/hash proof](implementation/verification.json)
- [Implementation rationale](implementation/REPORT.md)
- [Raw timing runs](timings/)
- [Functional state captures](interactions/)
- [Live provenance](provenance.json)

The three attestation SHA fields were updated for this lossless byte-only re-encode; decoded pixels retain the approved v0.7.1 images. No release approval command or production workflow was invoked. Existing marketing capture preserves optimized committed bytes when a fresh capture is visually identical. A future substantive recapture can replace these encodings and may need separate recompression.

Scripts are retained beside this report, with source mutation/verification scripts under implementation/. Absolute original workspace paths are recorded for provenance; adjust the task root when reproducing elsewhere. Production build drivers unset credentials and use only supported loopback fixtures. See measurement-summary.json for exact formulas. All evidence is task-only and deliberately stored under .agent-layer/tmp; this selected copy is committed to make this PR visually reviewable. Complete local logs/caches/worktrees are preserved outside this selected publication bundle.
