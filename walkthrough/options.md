# Options and .editorconfig

Shell Formatter reads the same `.editorconfig` keys as the shfmt command line tool, so the editor, the team and CI get the same result:

```ini
[*.sh]
indent_style = space
indent_size = 2
switch_case_indent = true
binary_next_line = true

[[bats]]
indent_size = 4
```

Keys: `indent_style`, `indent_size`, `shell_variant`, `binary_next_line`, `switch_case_indent`, `space_redirects`, `keep_padding`, `function_next_line`, `simplify`, `minify` and `ignore`.

Without `.editorconfig`, the `shellFormatter.*` settings apply, and the indent follows the editor (tabs, or spaces with its tab size).

The command "Copy the Matching shfmt Command" puts the exact shfmt command for the open file on the clipboard, for a CI step or a pre-commit hook.
