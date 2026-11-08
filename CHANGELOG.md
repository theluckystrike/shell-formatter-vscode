# Changelog

## 0.1.0

- First release. Formats bash, sh (POSIX), mksh, bats and zsh scripts with shfmt 3.14.1 compiled to WebAssembly. Nothing to download or install, works offline and on every OS, also in Remote SSH, WSL and dev containers.
- Reads the shfmt keys from `.editorconfig` (indent, shell_variant, binary_next_line, switch_case_indent, space_redirects, keep_padding, function_next_line, simplify, minify, ignore, and `[[shell]]` / `[[bash]]` sections).
- On a syntax error the file stays unchanged and the Problems panel shows the line and column.
- Checks that the formatted script parses to the same commands before a change is applied (files up to 256 KB).
- Skips Dockerfiles, `.env` files, fish and csh scripts. Format Selection, format on save, a status bar item with the engine version, and a command that copies the matching shfmt command for CI.
- Files up to 2 MB format in well under 2 seconds; files over 10 MB get a message instead.
