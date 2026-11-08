#!/bin/bash
declare -A ports=( [web]=80 [api]=8080 )
list=( a b   c )
for k in "${!ports[@]}"; do   printf '%s=%s\n' "$k" "${ports[$k]}"; done
if [[ ${#list[@]} -gt 2 && "$1" =~ ^[0-9]+$ ]];then
echo "many: ${list[*]}"
fi
(( count = ${#list[@]} * 2 ))
echo $count
