// Shown in "What's new" on the Home page after an update. Newest first, written for users.
export const CHANGELOG = [
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
