import { describe, expect, test } from "bun:test";
import { genericCredentialStepAccounts } from "./match.js";

describe("genericCredentialStepAccounts — steps run through a shell script or a prefix command", () => {
  test.each([
    // A shell's `-c` script is read as the steps it runs.
    ["sh -c 'cloud-creds refresh'", []],
    ['bash -c "cloud-creds refresh"', []],
    ["bash -lc 'some-cli credentials update --role Admin'", []],
    ["bash -e -c 'some-cli credentials update --account $ACCT'", ["$ACCT"]],
    ['sh -c "some-cli credentials update --account \\"$ACCT\\""', ['"$ACCT"']],
    ["/bin/sh -c 'cloud-creds refresh --account 444455556666'", ["444455556666"]],
    ["zsh -o pipefail -c 'cloud-creds refresh'", []],
    ["sh -c 'cd infra && cloud-creds refresh'", []],
    ["sh -c 'cd infra; some-cli assume 444455556666 | tee log'", ["444455556666"]],
    ["sh -c 'if true; then cloud-creds refresh; fi'", []],
    ["sh -c 'cloud-creds \"$@\"' _ refresh", ['"$@"']],
    ["sh -c 'sh -c \"cloud-creds refresh\"'", []],
    ["sudo bash -c 'cloud-creds refresh'", []],
    ["env FOO=1 sh -c 'cloud-creds refresh'", []],
    // A script with no credential step, a script file and a script the reader can't read are no credential step.
    ["sh -c 'ls -la && git status'", null],
    ["sh -c 'git commit -m \"rotate credentials\"'", null],
    ["sh -c 'grep -q 444455556666 accounts.txt'", null],
    ["bash deploy.sh", null],
    ['bash -c "$CMD"', null],
    ["sh -c", null],
    // eval's words and env -S's string are read as the command they run.
    ["eval 'cloud-creds refresh'", []],
    ['eval "cloud-creds refresh --account $ACCT"', ["$ACCT"]],
    ["eval 'git status'", null],
    ["env -S 'cloud-creds refresh'", []],
    // A prefix command runs the step's program after its own options, assignments and operands.
    ["env FOO=1 cloud-creds refresh", []],
    ["env -u AWS_PROFILE cloud-creds refresh", []],
    ["env -i PATH=/usr/bin /opt/bin/cloud-creds update --no-cache", []],
    ["env -- cloud-creds refresh", []],
    ["sudo cloud-creds refresh", []],
    ["sudo -u bob -E cloud-creds refresh", []],
    ["sudo FOO=1 some-cli credentials update --account 444455556666", ["444455556666"]],
    ["nice cloud-creds refresh", []],
    ["nice -n 10 cloud-creds refresh", []],
    ["nice -10 cloud-creds refresh", []],
    ["timeout 30 cloud-creds refresh", []],
    ["timeout -s KILL 30s cloud-creds refresh", []],
    ["timeout --signal=KILL 30 docker-credential-x renew", []],
    ["command cloud-creds refresh", []],
    ["exec cloud-creds refresh", []],
    ["nohup cloud-creds refresh", []],
    ["time cloud-creds refresh", []],
    ["xargs -n 1 cloud-creds refresh", []],
    ["sudo env FOO=1 nice -n 5 timeout 30 cloud-creds refresh", []],
    ["sudo some-cli assume 444455556666", ["444455556666"]],
    ["env FOO=1 deploy-tool --role Admin --account $ACCT", ["$ACCT"]],
    ["sudo some-vault exec --role Admin -- ls", []],
    // A prefix of a program that names nothing of credentials, or of a word reader, or with no program after it, is no credential step.
    ["env FOO=1 ls -la", null],
    ["sudo grep -q 444455556666 accounts.txt", null],
    ["timeout 30 grep -rn credentials docs", null],
    ["env FOO=1", null],
    ["sudo -i", null],
    ["timeout 30", null],
    // `command -v` prints where the program is and runs nothing.
    ["command -v cloud-creds", null],
    ["command -V cloud-creds", null],
  ])("%p reads as %p", (step, accounts) => {
    expect(genericCredentialStepAccounts(step)).toEqual(accounts);
  });
});

describe("genericCredentialStepAccounts — option clusters, redirects, more wrappers and command substitutions", () => {
  test.each([
    // A short-option cluster ending in an option that takes a value takes the next word as its value.
    ["sudo -iu bob cloud-creds refresh", []],
    ["sudo -Eu bob cloud-creds refresh", []],
    ["sudo -nu bob some-cli credentials update --account 444455556666", ["444455556666"]],
    ["sudo -ubob cloud-creds refresh", []],
    ["sudo --user=bob cloud-creds refresh", []],
    ["env -iu FOO cloud-creds refresh", []],
    ["nice -n10 cloud-creds refresh", []],
    ["env -iS 'cloud-creds refresh'", []],
    ["env -S'cloud-creds refresh'", []],
    ["env --split-string='cloud-creds refresh'", []],
    ["sudo -iu bob git status", null],
    // A redirect before the program, or among a prefix command's options, is no program.
    [">/dev/null cloud-creds refresh", []],
    ["> /dev/null cloud-creds refresh", []],
    ["2>&1 cloud-creds refresh", []],
    ["&>log cloud-creds refresh", []],
    ["sudo >/dev/null cloud-creds refresh", []],
    ["timeout 2>/dev/null 30 cloud-creds refresh", []],
    [">/dev/null git status", null],
    // An escaped or quoted prefix command is the command.
    ["\\sudo cloud-creds refresh", []],
    ["'sudo' cloud-creds refresh", []],
    // A prefix command's script option, and wrappers that run the command after their options and operands.
    ["su -c 'cloud-creds refresh'", []],
    ["su bob -c 'cloud-creds refresh'", []],
    ["su - bob -c 'cloud-creds refresh --account $ACCT'", ["$ACCT"]],
    ["su bob", null],
    ["runuser -u bob -- cloud-creds refresh", []],
    ["runuser -u bob cloud-creds refresh", []],
    ["runuser bob -c 'cloud-creds refresh'", []],
    ["flock /tmp/l -c 'cloud-creds refresh'", []],
    ["flock -n /tmp/l cloud-creds refresh", []],
    ["script -qc 'cloud-creds refresh' /dev/null", []],
    ["script -q /dev/null", null],
    ["watch -n 5 cloud-creds refresh", []],
    ["watch 'cloud-creds refresh'", []],
    ["chroot /srv cloud-creds refresh", []],
    ["nsenter -t 1 -m cloud-creds refresh", []],
    ["strace -f -o trace.log cloud-creds refresh", []],
    ["taskset -c 0 cloud-creds refresh", []],
    ["chrt -f 1 cloud-creds refresh", []],
    ["systemd-run --user --unit creds cloud-creds refresh", []],
    ["unbuffer cloud-creds refresh", []],
    ["busybox sh -c 'cloud-creds refresh'", []],
    ["fish -c 'cloud-creds refresh'", []],
    ["fish --command='cloud-creds refresh'", []],
    ["pkexec --user root cloud-creds refresh", []],
    ["watch -n 5 git status", null],
    // find's -exec command is a step of its own.
    ["find . -name '*.json' -exec cloud-creds refresh \\;", []],
    ["find . -execdir some-cli credentials update --account 444455556666 {} +", ["444455556666"]],
    ["find . -name '*.json' -exec cat {} \\;", null],
    ["find . -name '*.json' -delete", null],
    // A command substitution runs a step of its own.
    ["echo $(cloud-creds refresh)", []],
    ['echo "$(cloud-creds refresh)"', []],
    ["echo `cloud-creds refresh`", []],
    ["diff <(cloud-creds refresh) old.txt", []],
    ["X=$(sudo cloud-creds refresh)", []],
    ["echo '$(cloud-creds refresh)'", null],
    ["echo $((1 + 2))", null],
    ['[ "$(aws sts get-caller-identity --query Account --output text)" = "444455556666" ]', null],
    ["git log --format=$(date +%s)", null],
  ])("%p reads as %p", (step, accounts) => {
    expect(genericCredentialStepAccounts(step)).toEqual(accounts);
  });
});

describe("genericCredentialStepAccounts — a program the caller knows writes credentials", () => {
  const known = (program: string) => /^(?:\S*\/)?corp-assume$/.test(program);
  test.each([
    ["corp-assume assume", []],
    ["env FOO=1 corp-assume assume", []],
    ["sudo corp-assume assume", []],
    ["sudo -iu bob corp-assume session --role Admin", []],
    ["sh -c 'corp-assume assume'", []],
    ["sh -c 'corp-assume session --role Admin'", []],
    ["timeout 30 corp-assume exec --role Admin -- ls", []],
    ["sudo /opt/bin/corp-assume assume --account 444455556666", ["444455556666"]],
    ["'corp-assume' assume", []],
    ["echo $(corp-assume assume)", []],
    ["sudo other-cli assume", null],
    ["sh -c 'git status'", null],
  ])("%p reads as %p", (step, accounts) => {
    expect(genericCredentialStepAccounts(step, known)).toEqual(accounts);
  });

  test.each(["corp-assume assume", "sudo corp-assume assume", "sh -c 'corp-assume session --role Admin'"])("%p names nothing of credentials to the generic reading alone", (step) => {
    expect(genericCredentialStepAccounts(step)).toBeNull();
  });
});
