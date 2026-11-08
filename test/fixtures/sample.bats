#!/usr/bin/env bats
setup() {
  export TMP=$(mktemp -d)
}
@test "adds numbers" {
run expr 1 + 2
  [ "$status" -eq 0 ]
[ "$output" = "3" ]
}
