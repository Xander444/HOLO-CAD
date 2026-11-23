# Mounting-plate voice check

Use the app on localhost or HTTPS. Finish **Voice setup**, if shown, and wait for **Listening**. This workflow uses the microphone for every CAD command. The browser may still show a permission or file dialog.

| Say | Verify |
| --- | --- |
| **New project** | The workspace is empty. Say **Confirm** if asked to replace the current workspace. |
| **Create a box 100 by 60 by 7** | A 100 × 60 × 7 mm plate is selected. |
| **Rename it to Voice Test Plate** | The selected object's name changes. |
| **Make it 8 millimeters tall** | The plate is 100 × 60 × 8 mm. |
| **Add four 6 mm through-holes to the top face, 10 mm in from the corners** | The top face highlights and four circles appear. The solid stays intact during preview. Wait for the preview to finish checking. |
| **Make them 8 mm** | All four circles increase to 8 mm. Their centers stay 10 mm from both adjacent edges. |
| **Apply** | A single four-hole feature appears. One **Undo** removes all four openings. **Redo** brings them back. |
| **Export STEP** | A STEP file is produced. Reopen it to confirm the plate dimensions and four through-holes. |

To check clarification, say **Add a hole pattern** on a selected rectangular solid without having chosen a face. The assistant asks for a face. Say **Use top face**, then **Cancel** and check the solid is unchanged.

## Point-and-speak chamfer

Enable the camera and choose **Select**. Point one index finger at the middle of an exposed long edge. Keep pointing while the edge is highlighted and say **Chamfer this by 2 mm**. When the preview is ready, say **Apply**. Only the highlighted edge should be beveled. Say **Set chamfer size to 1 mm**, then check that the same bevel changes.

If two edges meet under the pointer, move toward the middle of one edge. For a mouse check, open **Tools → Chamfer**, hover over one edge, and click when it highlights.
