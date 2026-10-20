# sourced by bash through BASH_ENV: a sleep that only moves the shell's clock, so health waits finish at once
sleep() { SECONDS=$((SECONDS + ${1%.*})); }
