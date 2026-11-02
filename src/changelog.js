// Shown in "What's new" on the Home page after an update. Newest first, written for users.
export const CHANGELOG = [
  { version: '0.13.0', notes: [
    'Copy and paste layers between tabs: with no pixels selected, Ctrl+C copies the selected layers and Ctrl+V pastes them into any tab, Shirt or Pants or another project. Text, shapes and paths stay editable. With a selection, Ctrl+C still copies just those pixels.',
    'Fixed: the selection box showed no outline after you dragged it, so it looked like nothing was selected.',
    'Mirror is now exact: Brush, Pencil and Eraser strokes come out pixel for pixel the same on both sides, including scattered and angled brushes and even pencil sizes.',
    'Editing a mirrored path with Mirror on now updates its twin on the other side: moving points and handles, changing a point type and deleting points.',
  ] },
  { version: '0.12.0', notes: [
    'Scroll to zoom: scrolling over the canvas now zooms in and out around your mouse, like Pixlr. No key to hold.',
    'Scrollbars on the canvas: when you zoom in past the edges, drag the bars to move around. Shift + scroll moves left and right, Alt + scroll moves up and down.',
  ] },
  { version: '0.11.1', notes: [
    'Body types for the 3D preview: pick Woman, Blocky (R15) or Classic (R6) from the Body list in the Preview panel. Your choice is remembered.',
    'The Blocky (R15) body now splits the arms, legs and torso at the same places Roblox does, so elbows, knees, hands, feet and the waist line up with the game.',
    'Selections are now undo steps: making a selection, Select all, Invert selection and Deselect all show in History and can be undone.',
    'Changing a shape, line or text setting just before switching between Shirt and Pants no longer drops that change from History.',
    'Arrow keys nudge a selected shape, line or text with the Shape and Text tools too, not just the Move tool.',
    'The width box for a line shows its real width instead of 0px.',
  ] },
  { version: '0.11.0', notes: [
    'Tidier menus: related commands are grouped into submenus that open beside them, such as Layer → Mask, Merge, Flip and Symmetrize, Canvas → Rotate and Flip, and File → Export.',
    'Long menus stop at half the window and scroll, so they never run off the screen.',
  ] },
  { version: '0.10.1', notes: [
    'Symmetrize (Layer → Symmetrize right → left / left → right): makes a layer match on both sides by copying one side onto the other, flipped. On templates it copies the arm or leg and that side of the torso, and evens out the front, back, top and bottom. On a normal canvas it copies one half onto the other.',
  ] },
  { version: '0.10.0', notes: [
    'Mirror: turn it on for a layer (Shift+M, Layer → Mirror on / off, or the layer settings) and what you draw is drawn on the other side too. One arm draws on the other arm, one half of the torso on the other half, and the back and top stay symmetrical. On a normal canvas it flips across the middle.',
    'Mirror works with the Brush, Pencil and Eraser. A path drawn with Mirror on gets a twin on the other side that you can edit on its own.',
    'Only what you do while Mirror is on gets mirrored, and it stays when you turn Mirror off.',
    'Shirt and pants side by side: the new button next to Shirt / Pants shows both at once. Click the other one to work on it. Turn it off any time.',
    'Recent colours are remembered after you close the app, and they show in the colour window too.',
  ] },
  { version: '0.9.0', notes: [
    'Save preview image has a Copy image button: copy the picture straight to the clipboard and paste it anywhere, no file needed. The window stays open so you can copy another view.',
  ] },
  { version: '0.8.3', notes: [
    'The "3/4 front + back" preview image now shows the back turned the right way: the same pose as the front, seen from behind.',
  ] },
  { version: '0.8.2', notes: [
    'Layers that use your Colours (colour fills) now always show up when you open a project. Before, they sometimes stayed blank until you changed a colour.',
  ] },
  { version: '0.8.1', notes: [
    'The select box no longer jumps when you start dragging: the pixel you press on always stays a corner of the box.',
    'Save preview image has a new "3/4 front + back" view: the three-quarter front next to the back, turned the other way.',
  ] },
  { version: '0.8.0', notes: [
    'Seams now work like drawing on the real body: with Seams ticked, a Brush, Pencil or Eraser stroke that runs off a face carries on from the edge it joins. Untick Seams to draw normally.',
    'Painting on the 3D preview and the red seam check have been removed. The new Seams makes them unnecessary.',
    'Selecting several layers and dragging them (or using the arrow keys) moves them all together.',
    'Snap guides are green when you line up with another layer and pink for the canvas and template.',
    'Opening a Pixlr file the size of a template asks whether to open it as a normal canvas or as a shirt or pants. Other sizes open as a normal canvas at their own size.',
    'Typing a new width or height for a layer resizes it from its centre.',
    'Deleting the last layer leaves a new blank layer instead of refusing.',
    'Rotating a gradient (or a drop shadow) on text now works.',
    'The Fill box for text and shapes shows the fill colour again.',
  ] },
  { version: '0.7.0', notes: [
    'Paint on the 3D model: turn on the brush button under the preview and paint straight onto the body with the Brush, Pencil, Eraser, Fill or Eyedropper. Right-drag turns the model.',
    'Seams: tick Seams to see which edges join on the body and where the colours don’t match. The Brush and Eraser can wrap strokes over an edge onto the face it joins (Wrap seams).',
    'Save preview image now makes clean pictures for your store: front, back, both side by side, three-quarter or side views, at up to 2048 px, on a transparent or coloured background.',
    'Layer masks: hide parts of a layer without erasing them. Click the mask button under the layers, then paint black to hide and white to bring it back. Works on text and shapes too.',
    'Version history: earlier copies of each project are kept as you work. Restore one, or open it as a new project, from the clock button on a project or File → Version history.',
    'Home: search your projects, sort them, and sort them into folders (drag a project onto a folder).',
    'Keyboard shortcuts: press ? (or Help → Keyboard shortcuts) to see them all, and click one to change it.',
    'The 3D preview updates much faster, so painting on templates is smoother.',
    'Colour windows only open once, the colour picker’s circle is round, and going to Home closes any open editor windows.',
  ] },
  { version: '0.6.1', notes: [
    'Long brush and pencil strokes no longer lag.',
    'Painting on text or a shape offers to paint on a new layer above it instead.',
    'Clicking off text or a shape just deselects it. Click again to add a new one.',
    'While typing, text shows just its outline. Resize and rotate it once you are done.',
    'Resize handles stay lined up with text as it grows, and dragging one side keeps the other side in place.',
    'Pixel-only actions are greyed out while text or a shape is selected.',
    'Stitch Editor opens straight onto the Home page, and popups grow from their centre.',
  ] },
  { version: '0.6.0', notes: [
    'Snapping: moving or resizing lines things up with the canvas edges and centre, other layers, and the template outlines. Hold Ctrl to skip it, or turn Snap off in the Move tool.',
    'Move, resize and rotate shapes with the Shape tool, and text with the Text tool - no need to switch to Move. Click text to edit it, drag it to move it.',
    'Text and shapes stay editable: the fill bucket recolours them, Flip flips them, and painting asks before turning them into pixels.',
    'Dragging text is much smoother.',
    'Sizes and positions stay whole numbers when you resize or draw.',
  ] },
  { version: '0.5.0', notes: [
    'Smoother feel: panels slide open and shut like drawers, and popups, menus and the Home page fade in and out.',
    'Full screen with F11, or Panels → Full screen.',
  ] },
  { version: '0.4.1', notes: [
    'Image size and Canvas size now really resize Normal projects (Ctrl+Z undoes it). Templates stay at 585 × 559.',
    'Check for updates right from the Home page.',
    'The New project window and this What’s new card sit in the middle of the screen, and clicking outside closes them.',
    'Text boxes now highlight in blue when you type in them.',
  ] },
  { version: '0.4.0', notes: [
    'New Home page: your projects are saved automatically and listed with a preview. Open one, create a new one, or drop a file in to import it.',
    'Duplicate or delete projects from Home.',
    'New project types: Template (Roblox shirt + pants with the 3D preview) or Normal (a plain canvas, 1920 × 1080 by default, or any size you like).',
    'Go back to Home any time with the house button at the top left.',
    'Projects that were open before this update have been moved into your project list.',
  ] },
  { version: '0.3.1', notes: ['Update checks are more reliable.'] },
];
