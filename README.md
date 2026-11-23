# HOLO-CAD

HOLO-CAD is a voice-first 3D modeling workspace with webcam gestures, mouse, and keyboard controls. It builds editable solids with OpenCascade and exports STEP or binary STL.

## Run locally

Use Node.js 20.19+ on the 20.x line, or Node.js 22.12+. From this project folder, run

```sh
npm install
npm run dev
```

Open the localhost address printed by Vite. The rotor housing example is ready to edit. Use the project menu to start with an empty workspace.

The production bundle includes the geometry kernel, hand-tracking runtime, and model. Run `npm run build` from a Git checkout to generate `dist/`. Serve that folder on localhost or an HTTPS static host. With Python installed, run

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Run `npm run build` to rebuild the bundle after editing the source. Run `npm test` for the automated checks.

## Model a part by voice

1. In the voice dock, follow **Voice setup** or **Enable mic** if the browser requires it.
2. Start with **Create a cube 25** or **Select the bearing collar**. Say **What is selected?** to hear the active part.
3. Say **Draw a line 100 millimeters**, then **Create rectangle 100 by 50**, then **Extrude 20** to make a solid.
4. Say **Move it up 5**, **Top view**, or **Split it**. At the split prompt, set the plane and confirm the preview.
5. Say **Save** for the local library, **Save As** for a portable project, or **Export STEP** for a CAD file.

Voice stays on while the workspace is open unless muted or paused by the browser. The microphone button remembers the mute setting. The dock uses on-device speech when available and lets you opt into browser speech. Turn on **Hands** in the dock for hand controls. Move a hand to aim, hold a pinch over a part in **Select**, then release to select it. Open **Tools** or **Objects** in the header to use the full mouse and keyboard workspace.

- [Build a mounting plate by voice](docs/VOICE_CHECK.md)
- [Complete voice, hand, and keyboard controls](docs/CONTROLS.md)
- [Architecture, verification, and limitations](docs/ENGINEERING.md)

## Dependencies

React and Vite provide the application shell. Three.js draws the viewport and handles picking. Replicad uses its OpenCascade WebAssembly build for B-rep modeling. MediaPipe supplies the Hand Landmarker model and CPU runtime. Dependency versions are pinned in `package-lock.json`. The model is bundled at `public/models/hand_landmarker.task` with SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`. [Replicad library documentation](https://replicad.xyz/docs/use-as-a-library/), [MediaPipe Hand Landmarker for Web](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js), [Google Hand Landmarker model](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task)
