# QuestPort

Play classic Sierra adventure games (King's Quest, Space Quest, Police Quest...) in the browser.
From-scratch TypeScript reimplementations of the **AGI v2** and **SCI0** interpreters.

No game data is included: load your own copy of the game files (or drop the original floppy images) on the page.
Tested with Space Quest I (AGI 2.089 and 2.917), Space Quest II (AGI 2.936) and Space Quest III (SCI0 0.000.685).

## License note

QuestPort is licensed under GPL-3.0-or-later (see `LICENSE`). The SCI0 engine (`src/sci/`) closely follows
ScummVM's GPL-licensed SCI engine (algorithms and lookup tables such as picture brush patterns).
Sierra's game data is copyrighted and is not part of this project; neither are AI repaints made from it.
Not affiliated with Sierra or its current owners; game names are trademarks of their owners.

## Run

    npm install
    npm run dev        # open the printed URL (e.g. http://localhost:5173)

Game files in `public/games/sq1/` load automatically. Without them, the page asks you to pick or drop
files: either the extracted AGI files (LOGDIR, PICDIR, VIEWDIR, SNDDIR, VOL.*, OBJECT, WORDS.TOK)
or the original `.ima` floppy images, which are read directly.

Other AGI v2 games may work; pass `?version=2440` (hex interpreter version) if their scripts need
a newer opcode table. AGI v3 games (compressed resources, combined DIR file) are not supported yet.

## Layout

| File | What it does |
|---|---|
| `src/resources.ts` | Directory + VOL resource loading |
| `src/picture.ts` | Vector picture renderer (visual + priority screens) |
| `src/view.ts` | Sprite (view/loop/cel) decoder |
| `src/logic.ts` | Logic scripts, opcode table, disassembler |
| `src/interpreter.ts` | The VM: main cycle, motion, collision, all commands, save/restore |
| `src/words.ts` | WORDS.TOK dictionary and text parser |
| `src/sound.ts` | 3-voice + noise (PCjr/Tandy) sound renderer |
| `src/screen.ts` | 320x200 compositor, text, message windows |
| `src/main.ts` | Browser glue: canvas, keyboard, audio, file loading |

## SCI0 engine (`src/sci/`)

| File | What it does |
|---|---|
| `resource.ts` | RESOURCE.MAP / RESOURCE.00n loading, LZW + Huffman decompression |
| `picture.ts`, `screen.ts` | Vector pictures (visual/priority/control screens, EGA dithering), priority bands |
| `gfx.ts` | Views, fonts, ports/windows, painting primitives |
| `vm.ts` | Script VM: segments, objects/classes, bytecode, sends, save/restore of the heap |
| `kernel/core.ts` | Lists, strings, math, time, misc kernel calls |
| `kernel/windows.ts`, `text.ts`, `controls.ts`, `menu.ts` | Windows, text, dialogs, menu bar, status line |
| `kernel/animate.ts`, `movement.ts`, `transitions.ts` | Pictures, cast animation, collision, movement, transitions |
| `kernel/input.ts`, `parser.ts` | Events and the SCI0 text parser / Said matching |
| `kernel/sound.ts`, `sound.ts` | kDoSound and the SCI0 sound renderer (AdLib FM / PCjr) |
| `kernel/files.ts` | Virtual files and save games (localStorage) |
| `engine.ts` | Wires everything together and runs the game loop |

## Tools (Node, for debugging)

    npx tsx tools/pics.ts <outdir> [n...]   # render pictures to PNG
    npx tsx tools/views.ts <outdir> n...    # render view sprite sheets
    npx tsx tools/disasm.ts [n]             # disassemble logic scripts
    npx tsx tools/play.ts <outdir> steps... # headless play: w<cycles> t<text> k<key> s<shot>

    npx tsx tools/scipics.ts <outdir> [n...]   # render SCI pictures
    npx tsx tools/sci-play.ts <outdir> steps... # headless SCI play: w<ms> k<key> t<text> c<x>,<y> s<shot>
    npx tsx tools/parsertest.ts                 # SCI parser tests

Saves are stored in the browser's localStorage.

## AI Images mode (SCI)

"Space Quest III — AI Images" shows the same game with repainted art:

- Room backgrounds (`tools/sci-ai-pics.ts`) and sprites (`tools/sci-ai-views.ts`) are repainted with
  xAI's image editor (key in `.env.local` as `XAI_API_KEY`) and stored in `public/games/sq3/ai`.
  Mostly empty pictures use `STRICT=1` so empty space stays empty.
- The engine records what drew every screen pixel (room picture, sprite cel, text glyph, other).
  `src/sci/ai-compose.ts` takes room pixels from the repainted background and sprite pixels from the
  repainted sprite sheet, so walking behind things and all game logic are unchanged.
- Text is redrawn with a smooth font (`public/fonts/text.ttf`, Source Sans 3, OFL) by `src/sci/ai-text.ts`.
- Anything without a repaint falls back to the original EGA art. To drop a repaint, remove its entry
  from `public/games/sq3/ai/index.json`.
- `AI=1 tsx tools/sci-play.ts ...` also writes the blended 1280x800 frame for each screenshot.
