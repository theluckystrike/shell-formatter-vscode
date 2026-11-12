'use strict';
// REACH1 (lane NEWSHIP): this listing's Pro tools for the toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  "prefix": "shellFormatter",
  "triesKey": "shellFormatter.proTrial",
  "slot": "",
  "tools": [
    {
      "id": "folder",
      "title": "Format All Shell Scripts in a Folder",
      "command": "shellFormatter.formatFolder",
      "folderMenu": true
    },
    {
      "id": "check",
      "title": "Formatting Check with a Patch File",
      "command": "shellFormatter.checkFolder",
      "folderMenu": true
    },
    {
      "id": "minify",
      "title": "Minify a Script to a Copy",
      "command": "shellFormatter.minifyCopy"
    }
  ]
};
