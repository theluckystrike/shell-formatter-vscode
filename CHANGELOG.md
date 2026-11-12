# Changelog

## 0.1.1 (2026-11-12)

- First Marketplace release. Everything in 0.1.0 below stays free: format document, selection and on save with shfmt 3.14.1 built in, .editorconfig, syntax errors in Problems, the same commands check.
- New Zovo Pro tools, 3 free tries each on this computer: Format All Shell Scripts in a Folder, Formatting Check with a Patch File (a unified diff of every change, nothing is changed), and Minify a Script to a Copy. Right-click a folder or a script in the Explorer for the "Zovo Pro:" entries. Nothing about Pro shows until you click one of them.
- The rating ask follows the shared Zovo rule 2.3: it comes at the earliest after scripts were formatted on two occasions at least 30 minutes apart, never after an error, at most twice.
- "More free tools by Zovo" and the README list related Zovo extensions. A link opens the extension page; nothing installs on its own.

## 0.1.0

- First release. Formats bash, sh (POSIX), mksh, bats and zsh scripts with shfmt 3.14.1 compiled to WebAssembly. Nothing to download or install, works offline and on every OS, also in Remote SSH, WSL and dev containers.
- Reads the shfmt keys from `.editorconfig` (indent, shell_variant, binary_next_line, switch_case_indent, space_redirects, keep_padding, function_next_line, simplify, minify, ignore, and `[[shell]]` / `[[bash]]` sections).
- On a syntax error the file stays unchanged and the Problems panel shows the line and column.
- Checks that the formatted script parses to the same commands before a change is applied (files up to 256 KB).
- Skips Dockerfiles, `.env` files, fish and csh scripts. Format Selection, format on save, a status bar item with the engine version, and a command that copies the matching shfmt command for CI.
- Files up to 2 MB format in well under 2 seconds; files over 10 MB get a message instead.
