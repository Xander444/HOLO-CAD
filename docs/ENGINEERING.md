# Architecture and verification

## Modeling

- `src/models/` defines millimeter-based geometry, construction frames, versioned projects, and recursive feature recipes. The project format stores analytic primitive and profile definitions, operand transforms, split planes, attachment links, appearance, and operation histories. STEP imports carry serialized B-reps.
- `src/cad/` executes OpenCascade operations in a worker and caches tessellation. The kernel checks result topology and positive solid volume. Splits use an oriented plane and check volume conservation. Failed candidate geometry leaves the committed project intact.
- The four-hole pattern stores one rectangular face reference, diameter, and inset. OpenCascade computes the four cuts from that face's outer boundary each time the pattern is rebuilt. The chamfer stores a geometric edge reference and equal setback distance. The pick requires a visible, unambiguous edge and the open draft verifies the candidate solid before applying.
- `src/commands/` and `src/app/model.ts` apply immutable transactions. Undo and redo restore a bounded sequence of project snapshots. Previews live in `src/interactions/` and each confirmed drag produces one history entry.
- `src/viewport/` renders CAD tessellation, sketches, previews, dimensions, picking, and transform handles. Planar placement support is computed from exact kernel bounds in the requested direction. Cached CAD vertices, endpoints, and planar face centers serve as snap references.
- `src/vision/` uses CPU MediaPipe inference in an image-frame worker, with a browser-thread fallback. The tracker uses per-landmark smoothing, confidence, and identity assignment using motion and handedness. `src/gestures/` handles dwell, release, tracking loss, and mutually exclusive gestures.
- `src/voice/` maps transcripts and text into the same modeling workflow. The parser resolves part names, selected objects, pending prompts, and recently edited dimensions. The recognition session prefers on-device speech, renews expired sessions, and pauses during speech synthesis. Browser speech requires opt-in and the mute preference is saved locally. IndexedDB stores named projects and the latest autosave. The static app includes no telemetry.

## Verified

Automated tests exercise the OpenCascade WASM kernel and the shared gesture, pointer, and text workflows. They cover precision sketch extrusion, editable cylinder dimensions, unit conversion, face centering, contact-based attach and fuse, disjoint fusion failure, plane splitting with conserved volume, history, gesture conflicts, offscreen deletion confirmation, tracking loss, project reconstruction, hole and cutout geometry, and STL closure and STEP round-trip dimensions.

Browser verification used the mouse to draw a line, extend it into a 100 × 50 mm rectangle, extrude 20 mm, and split the solid. It also exercised move, undo, redo, saving, and restoration through a reload. The browser worker and browser-thread MediaPipe fallback each detected two hands and 21 landmarks per hand from the same local test frame. [MediaPipe test frame](https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg)

Voice lifecycle tests simulate browser recognition and check startup, mute, session renewal, permission recovery, browser-service opt-in, and speech prompt echo prevention. Context tests exercise spoken part names, relative measurements, follow-up edits, and split confirmation. Hand samples cover the added poses, sustained holds, and repeat prevention.

The simulated voice-only mounting-plate test creates the plate, corrects its height, changes the four-hole preview, applies the feature, undoes and redoes it, then round-trips a STEP export. A Chromium production-build check repeated that workflow with injected speech recognition results, saved STEP through the browser export flow, picked a visible edge, and applied a chamfer. The automated tests also cover face clarification, rejection when no edge is aimed at, and the expected volume of a single-edge chamfer. [Live verification steps](VOICE_CHECK.md)

## Manual hardware checks

With the app served on HTTPS or localhost:

1. Enable the camera and calibrate. Check that both mirrored landmark overlays remain aligned as hands cross. Hide and show the preview, then disable the camera and confirm its indicator turns off.
2. Pinch and grow a line, then set its length to 100 mm. Extend the selected line into a 50 mm-high rectangle and extrude 20 mm. Validate the dimensions in Properties.
3. Trace an orbit arc with close fingers. Use the spread scissors pose on a selected solid. During a move, remove the grabbing hand and verify that the preview freezes and expires without placement.
4. Bring a solid to a planar contact and try Attach. Undo, then retry with Fuse. Test an offscreen grab with No and Yes and restore it with Undo.
5. On a browser with recognition enabled, say **two inches** during a length prompt and verify 50.8 mm. Confirm that spoken prompts do not trigger commands. Disable the microphone and repeat with keyboard input.
6. Compare responsiveness on the intended webcam, lighting, and browser. Inspect frame pacing with the example and a larger assembly.

## Limitations

- Live webcam ergonomics and live microphone recognition still need device testing. Initial browser permission or user activation may require a click. Speech availability and reported confidence depend on the browser and language pack. [Web Speech API](https://webaudio.github.io/web-speech-api/)
- General affine scaling of arbitrary Boolean, split, imported, and curved extruded bodies is unavailable in the bundled OpenCascade binding. Those bodies support uniform scaling and source-dimension edits. Primitives and straight-sided extrusions accept supported per-axis scaling.
- The hole pattern supports four through-holes on a face with a rectangular outer boundary. A chamfer's source edge must still match its stored geometry when the feature is rebuilt. If a source edit changes that edge, the app rejects the candidate so a different edge stays untouched.
- Sketches are dimensioned individual profiles. Constraint solving across multiple sketches and general feature-timeline reordering are outside this implementation. Edits rebuild the affected saved recipe and connected profile extrusions.
- Curved edge snaps use the closest tessellated segment. Planar face support and analytic dimensions use the kernel. Surface clicks are limited by viewport picking resolution.
- STEP and binary STL support visible solids only. STL stores tessellated millimeter coordinates without unit metadata. STEP import retains valid solids as B-reps. Project files preserve editable recipes. Undo and redo start a new session after reopening.
- Browser storage is scoped to the browser profile and origin. Save As creates a portable copy. Large models and cold WebAssembly loads can take longer depending on hardware.
