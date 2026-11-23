# Commands and shortcuts

See the [complete controls guide](CONTROLS.md) for voice setup, object names, follow-up phrases, new hand signs, and all shortcuts. Type commands into the dock or speak them while the microphone is listening. When a dimension is highlighted, a number alone sets that dimension. Commands without a length unit use millimeters. Inspector fields use the current display unit.

| Action | Example commands |
| --- | --- |
| Numbers and units | `75`, `10 centimeters`, `2 inches`, `one and a half inches`, `twelve point five`, `one hundred and twenty` |
| Create solids | `Create a box`, `Create a cube`, `Create a cylinder with diameter 30 and height 70`, `Create a tube with diameter 64 and inner diameter 38` |
| More primitives | `Create a sphere`, `Create a cone`, `Create a rectangular prism` |
| Sketch and extrude | `Draw line`, `Create rectangle 100 by 50`, `Create a circle with diameter 40`, `Extrude -25` |
| Edit features | `Set diameter to 40`, `Make the height 80`, `Set the radius to 15`, `Set depth to 20` |
| Move and rotate | `Move left 10`, `Move up 25`, `Move to 0, 0, 15`, `Rotate 90 degrees around X`, `Scale by 1.25` |
| Axes and planes | `Move along Z`, `Clear constraint`, `XZ plane`, `Snap to grid` |
| Alignment | `Centered`, `Align the centers`, `Center on X`, `Center on the face`, `Place flush`, `Align left edges`, `Align top` |
| Combine and cut | `Attach`, `Detach`, `Fuse`, `Subtract`, `Intersect`, `Cut`, `Keep both pieces`, `Make a hole` |
| Navigation | `Front view`, `Back view`, `Left view`, `Right view`, `Top view`, `Bottom view`, `Isometric view`, `Fit all`, `Reset view`, `Zoom in`, `Zoom out` |
| Confirmations | `Confirm`, `Yes`, `No`, `Cancel`, `Delete` |
| Project | `Save`, `Save As`, `Open project`, `New project`, `Export STL`, `Export STEP`, `Display units inches` |
| History | `Undo`, `Redo`, `Duplicate` |

For subtract, intersect, or attach, select the target first and Shift-click the second object. In a hole preview, click a planar face to position the hole. Choose through-hole, blind hole, or rectangular cutout in the prompt. Change dimensions before applying.

## Mouse and keyboard

- Drag the viewport to orbit, right-drag to pan, and scroll to zoom. Click a body to select it. Shift-click to select multiple bodies. Right-click for object actions.
- **V** Select, **L** Line, **R** Rectangle, **C** Circle, **E** Extrude, **G** Move, **T** Rotate, **S** Scale, **K** Split, **M** Measure.
- **X**, **Y**, and **Z** constrain the active axis. Press the same key again to clear it. **F** fits the whole model. **1** selects Front, **2** selects Top, and **3** selects Isometric.
- **Enter** confirms a modeling prompt. **Esc** cancels. **Delete** opens a deletion prompt. **/** focuses the command box.
- **Ctrl/Cmd+Z** undoes. **Ctrl/Cmd+Shift+Z** or **Ctrl/Cmd+Y** redoes. **Ctrl/Cmd+D** duplicates, **Ctrl/Cmd+S** saves locally, **Ctrl/Cmd+Shift+S** saves a project file, and **Ctrl/Cmd+O** opens the library.
