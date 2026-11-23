# HOLO-CAD voice and hand controls

## Start with voice

HOLO-CAD starts listening when the browser has a usable speech recognizer and microphone access. Open the app on localhost or HTTPS. If the dock shows **Voice setup**, install the English on-device speech pack when available, or explicitly choose **Use browser speech**. Your browser may send audio to its speech provider in browser speech mode. **Enable mic** retries browser permission or activation.

The microphone button mutes or unmutes. You can also say **Mute microphone** or use **Alt+M** to toggle. The app remembers the mute state across reloads. The assistant briefly pauses recognition while it speaks, then resumes. Browser session endings and short interruptions trigger a reconnect. The dock shows when browser permission, setup, or another action is required.

Say one command at a time. A wake phrase is optional. You can start with **Hey HOLO-CAD**. Every modeling phrase below also works in **CAD command**. Say **What can I say?** to open the in-app guide. Use **Tools** and **Objects** in the header to reveal the mouse tools and the object inspector.

## Voice commands

### Select and ask about the model

| Action | Say or type |
| --- | --- |
| Select by name | **Select the bearing collar**, **Select cylinder one** |
| Select multiple objects in order | **Select the mounting plate and bearing collar** |
| Add to selection | **Add the shoulder ring to the selection**, **Select the shoulder ring too** |
| Select by list position | **Select the first part**, **Select the last object** |
| Select all or clear | **Select all**, **Select all solids**, **Select all sketches**, **Clear selection** |
| Find object names | **List objects**, **What parts do I have?** |
| Read the current selection | **What is selected?**, **Describe it** |
| Ask for a measurement | **How tall is it?**, **How wide is it?**, **How long is it?**, **How deep is it?**, **What’s its diameter?**, **What is the volume?** |
| Rename | **Rename it to Mounting Base** |
| Change visibility | **Hide the collar**, **Show the collar**, **Hide it** |
| Change color | **Make it blue**, **Paint it red** |

A unique word from the object name is enough. If two objects match, the assistant asks for the full name. **It**, **this**, and **that** usually refer to the last selected object. A recently edited dimension on that object can be updated by saying **Set that to 40**. An active dimension or tool prompt takes precedence.

### Create or edit geometry

| Action | Say or type |
| --- | --- |
| Create a solid | **Create a box**, **Create a cube**, **Create a cylinder**, **Build a sphere**, **Create a cone**, **Make a tube**, **Create a rectangular prism** |
| Shape synonyms | **Make a cuboid** for a box, **Build a ball** for a sphere, **Create a pipe** for a tube |
| Create a sized solid | **Create a red box 50 by 30 by 20**, **Create a cube 25**, **Create a cylinder with diameter 30 and height 70**, **Build a cylinder thirty millimeters wide and sixty tall** |
| Create a tube with a bore | **Create a tube with diameter 64 and inner diameter 38** |
| Create a dimensioned line | **Draw a line 100 millimeters** |
| Make a rectangular or circular sketch | **Create rectangle 100 by 50**, **Create a circle with diameter 40** |
| Open a sketch or measure tool | **Draw point**, **Draw line**, **Draw polyline**, **Draw rectangle**, **Draw circle**, **Draw ellipse**, **Draw arc**, **Measure** |
| Extrude a closed sketch | **Extrude 25**, **Extrude it by minus ten**, **Extrude the rectangle by twenty** |
| Open extrusion preview | **Extrude**, then say a signed number for the depth |
| Set a dimension | **Set diameter to 40**, **Make the height 80**, **Set radius to 15**, **Make it 30 millimeters tall** |
| Adjust a dimension | **Increase its height by 10**, **Make it taller by five**, **Make it five millimeters wider**, **Make it twice as tall** |
| Follow up on a dimension | **Set that to 45**, **Two inches**, **Twelve point five** |

Dimensions accept millimeters, centimeters, meters, and inches. A length without a unit uses millimeters. Angles default to degrees. Spoken numbers and fractions include **one hundred and twenty** and **one and a half inches**. Supported colors are red, orange, yellow, green, teal, cyan, blue, purple, pink, white, gray, and black. Some sketches and measurements use the camera or mouse to locate geometry.

### Place and reshape parts

| Action | Say or type |
| --- | --- |
| Move in a direction | **Move left 10**, **Move that up five**, **Lift it twenty millimeters**, **Move the base up 10** |
| Set a position | **Move to 0, 0, 15**, **Move it to X zero Y ten and Z twenty** |
| Move relative to current coordinates | **Move by 0, 10, 15**, **Move Z 8** |
| Rotate or scale | **Rotate it 90 degrees around X**, **Turn it 45 degrees**, **Scale by 1.25**, **Double it**, **Halve it** |
| Open the manipulation controls | **Move**, **Rotate**, **Scale** |
| Constrain an axis | **Move along Z**, **Axis X**, **Clear constraint** |
| Choose a plane or snap setting | **XY plane**, **XZ plane**, **YZ plane**, **Snap to grid** |
| Align two selected parts | **Centered**, **Align the centers**, **Center on X**, **Center on the face**, **Align left edges**, **Align top**, **Place flush** |
| Fuse, attach, or separate | **Fuse**, **Join them**, **Attach them**, **Detach** |
| Boolean operations | **Subtract**, **Intersect** |
| Split a solid | **Split it**, **Split the mounting plate**, then set a plane or say an offset such as **10 millimeters**, then **Keep both pieces** |
| Make a hole | **Drill a hole**, **Set diameter to 10**, **Confirm**. The hole prompt also accepts radius, width, height, and depth. Choose the face and hole type in the viewport when you need a custom placement. |
| Preview four corner holes | **Add four 6 mm through-holes to the top face, 10 mm in from the corners**. Supply a rectangular planar face by name, by clicking it, or by pointing and saying **Use this face**. The inset is measured from both adjacent edges to each hole center. |
| Revise or apply the pattern | **Make them 8 mm**, **Set hole inset to 12 mm**, **Apply**. The four openings commit together. Say **Set hole diameter to 10 mm** on the selected part or edit the feature in **Objects** to update all four later. |
| Chamfer an edge | In **Select**, point one finger at the middle of an exposed edge and hold until it highlights. Say **Chamfer this by 2 mm**. Review the preview, then say **Apply**. With a mouse, open **Tools → Chamfer**, then click the highlighted edge. |
| Adjust a chamfer | **Set chamfer size to 1 mm** changes the draft or edits the saved chamfer on the selected part. |

For alignment and attachments, select the reference first and the moving part second. For subtraction, select the target first and the tool second. The assistant previews alignment and cutting before committing. A pending join offers Attach, Fuse, or Place only. Confirm requests for deletion, cutting, and similar operations only when the intended preview is active.

### Navigate and manage the project

| Action | Say or type |
| --- | --- |
| Standard views | **Front view**, **Back view**, **Left view**, **Right view**, **Top view**, **Bottom view**, **Isometric view**, **Reset view** |
| Fit or zoom | **Fit all**, **Frame everything**, **Zoom in**, **Zoom out** |
| Toggle workspace panels | **Show tools**, **Hide tools**, **Show objects**, **Close inspector** |
| Units | **Display units inches**, **Units millimeters**, **Units centimeters**, **Units meters** |
| History | **Undo that**, **Redo**, **Go back one step** |
| Copy or delete | **Copy that**, **Duplicate the collar**, **Delete it**, **Delete the collar** |
| Accept or cancel a prompt | **Yes**, **Confirm**, **Go ahead**, **No**, **Cancel that**, **Never mind**, **Close dialog** |
| Projects | **New project**, **Open project**, **Save**, **Save As** |
| Export | **Export STEP**, **Export as STL**, **Save as an STL file** |
| Help or mute | **What can I say?**, **Show controls**, **Mute microphone**, **Stop listening** |

Browser file and microphone permission dialogs still use your browser’s controls.

## Hand signs and movements

Turn on **Hands** next to Settings and allow camera access. Move a hand to aim the crosshair. In **Select**, hold a pinch over a part until **Pinch to select** appears, then release. Move your whole hand to drag while pinching. Choose **Calibrate** in the camera preview if the workspace is hard to reach. Keep your palms well lit and visible. Mouse drags take priority over hand signs. A brief tracking loss freezes a preview. An extended loss cancels it.

| Sign or movement | What it does |
| --- | --- |
| One pinch | Hold a thumb–index pinch over an object, then release to select. |
| Point and hold | Extend only your index finger, point at a visible object, and hold steady in **Select**. |
| Point at an edge and speak | Hold one finger near the middle of one exposed edge until it highlights. Keep pointing and say **Chamfer this by 2 mm**. Review the preview and say **Apply**. |
| Two pinches and spread | Pinch thumb to index on both hands while **Select** or **Line** is active. Spread, then release both pinches close together to draw a line. |
| Pinch a selected line and pull | Pull perpendicular to the line to make a rectangle. Release and set the height. |
| Pinch the extrusion handle | Select a closed sketch. Pull its handle and release. Confirm the depth or say an exact signed value. |
| Close two raised fingers and trace an arc | Hold index and middle fingers close together and trace a small arc to orbit the camera. Release to stop. |
| Open hand, then fist | Hover over a solid, close your hand into a fist, and move. Open your hand to place it. |
| Grab and drag offscreen | Move the fist beyond the viewport until the red boundary appears. Open your hand to request deletion. Confirm separately. |
| Scissors | Select a solid. Open index and middle fingers into a V, trace the cut, then close those two fingers to commit. In **Split** mode, the selected cutting plane controls direction. |
| Thumbs up | Fold your other fingers and hold your thumb upright for about 0.6 seconds. Keeps a dimension or confirms an extrusion or alignment. |
| Thumbs down | Fold your other fingers and point your thumb down for about 0.6 seconds. Cancels a preview or pending prompt. |
| Three fingers | In **Select**, hold index, middle, and ring fingers up with the pinky folded. Fits the model to the view. |
| Index and pinky | In **Select**, extend the index and pinky and fold the other fingers. Hold steady to undo once. |
| Thumb and pinky | In **Select**, extend the thumb and pinky and fold the other fingers. Hold steady to redo once. |

Relax the pose before repeating a held sign. After a contact snap, use **Attach**, **Fuse**, or **Place only** to finish. The viewport and camera use their own controls. The camera estimates hand motion on the screen and maps it onto a virtual construction plane.

## Mouse and keyboard

- Click or Shift-click to select. Drag to orbit, right-drag to pan, and scroll to zoom. Right-click a solid for object actions.
- **V** Select, **L** Line, **R** Rectangle, **C** Circle, **E** Extrude, **G** Move, **T** Rotate, **S** Scale, **K** Split, **M** Measure.
- **X**, **Y**, or **Z** toggles an axis constraint. **F** fits the model. **1**, **2**, and **3** switch to Front, Top, and Isometric.
- **Alt+M** toggles microphone mute. **/** focuses the command box. **Enter** confirms. **Esc** cancels. **Delete** requests deletion.
- **Ctrl/Cmd+Z** undoes. **Ctrl/Cmd+Shift+Z** or **Ctrl/Cmd+Y** redoes. **Ctrl/Cmd+D** duplicates. **Ctrl/Cmd+S** saves locally. **Ctrl/Cmd+Shift+S** saves a portable project. **Ctrl/Cmd+O** opens the project library.
