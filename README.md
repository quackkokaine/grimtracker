# Grim Dawn Hardcore Tracker

A progress tracker for Grim Dawn hardcore characters, built around devotion shrines.

- Every devotion shrine on Normal, Elite and Ultimate, with what each one needs and its spot on the Grimtools world map
- **Game sync:** connect your save folder and your hardcore characters update by themselves while you play (Chrome or Edge)
- **Hall of the Fallen:** characters who die are added automatically, with their stats and gear
- **Game files (optional):** connect your Grim Dawn install folder to see gear names and stats

Everything is read on your own computer. Nothing is uploaded, and the game's files are never changed.

## Using it

Open the site, then:

1. **Connect save folder** and pick `Documents\My Games\Grim Dawn\save`
   (or `Steam\userdata\<id>\219990\remote\save` if you use Steam Cloud).
2. Optional: **Connect game folder** and pick your Grim Dawn install folder (the one with `Grim Dawn.exe`).

Progress is stored in your browser. Use **Backup** to keep a copy.

## Development

The page is a single `index.html` built from `src/`:

```
python3 build.py          # rebuild index.html
node tests/test_gdsave.js # save file reader tests
node tests/test_gddb.js   # game database reader tests
```

- `src/index.template.html`: page, styles and app code
- `src/gdsave.js`: reads `player.gdc` character files
- `src/gddb.js`: reads the game's item database (`.arz`) and text (`.arc`)
- `assets/`: logo and gravestone art

Shrine list and requirements come from the [Grimtools checklist](https://www.grimtools.com/checklist/shrines/normal). Save and game file formats are based on [gd-edit](https://github.com/odie/gd-edit) and lost.org.uk's save documentation. Fan-made, not affiliated with Crate Entertainment.
