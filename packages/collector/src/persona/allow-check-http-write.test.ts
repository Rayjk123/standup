import { describe, expect, test } from "bun:test";
import { callSignals, type AllowCheckInput } from "./allow-check.js";

/*
 * Which HTTP client calls carry the http-write intent: curl's body, form and
 * upload flags in every spelling, wget's post and method options, and
 * httpie's write methods and data items. Each call is read as text by
 * callSignals and never run.
 */

function input(call: string): Pick<AllowCheckInput, "toolName" | "call" | "floorReason" | "worktreeRoot"> {
  return { toolName: "Bash", call, floorReason: "", worktreeRoot: "/srv/ws/wt" };
}

function httpWrite(call: string): { call: string; http: boolean } {
  return { call, http: callSignals(input(call)).intents.includes("http-write") };
}

const URL = "https://api.example.com/x";

describe("an HTTP client's write flags are an http-write", () => {
  test("curl uploads and bodies in every spelling", () => {
    for (const call of [
      `curl -T f ${URL}`,
      `curl --upload-file f ${URL}`,
      `curl --upload-file=f ${URL}`,
      `curl -d@f ${URL}`,
      `curl -sd @f ${URL}`,
      `curl -sSd@f ${URL}`,
      `curl -sF a=@f ${URL}`,
      `curl -sT f ${URL}`,
      `curl -F a=@f ${URL}`,
      `curl --form a=@f ${URL}`,
      `curl --form-string a=b ${URL}`,
      `curl --data-binary @f ${URL}`,
      `curl --data-raw x ${URL}`,
      `curl --data-urlencode a=b ${URL}`,
      `curl --json '{}' ${URL}`,
      `/usr/bin/curl -T f ${URL}`,
      `X=1 curl -sd @f ${URL}`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("curl's write methods, glued or not", () => {
    for (const call of [
      `curl --request=POST ${URL}`,
      `curl --request PUT ${URL}`,
      `curl -XPOST ${URL}`,
      `curl -XDELETE ${URL}`,
      `curl -sXPATCH ${URL}`,
      `curl -sX PUT ${URL}`,
      `curl -X 'POST' ${URL}`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("a quoted flag is still the flag", () => {
    for (const call of [`curl "-d" @f ${URL}`, `curl '-d' @f ${URL}`, `curl "-T" f ${URL}`, `curl "-X" POST ${URL}`, `curl "--data-binary" @f ${URL}`]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("wget's post and method options", () => {
    for (const call of [
      `wget --post-data=a=b ${URL}`,
      `wget --post-data a=b ${URL}`,
      `wget --post-file=f ${URL}`,
      `wget --body-data=x --method=PUT ${URL}`,
      `wget --method=POST ${URL}`,
      `wget --method POST ${URL}`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("httpie's write methods and data items", () => {
    for (const call of [
      `http POST ${URL} a=b`,
      `https PUT api.example.com/x a=b`,
      `http --form POST ${URL} f@/tmp/f`,
      `http -v DELETE ${URL}`,
      `http ${URL} a=b`,
      `http ${URL} n:=1`,
      `xh post ${URL} a=b`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });
});

describe("other flags are no http-write", () => {
  test("a short flag of a program that is no HTTP client", () => {
    for (const call of [
      `ls -T 4 src`,
      `ls -sT src`,
      `tmux -S /tmp/r/s new -d -s x 'sleep 1'`,
      `tar -xTf list.txt`,
      `sort -T /tmp/r big.txt`,
      `git log -Xours`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: false });
    }
  });

  test("curl's read flags", () => {
    for (const call of [
      `curl -fsSL ${URL}`,
      `curl -sD /tmp/h ${URL}`,
      `curl -s -o /dev/null -w '%{http_code}' ${URL}`,
      `curl -X GET ${URL}`,
      `curl -XGET ${URL}`,
      `curl -HX-Trace:1 ${URL}`,
      `curl -sI ${URL}`,
      `curl -t TTYPE=vt100 telnet://h`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: false });
    }
  });

  test("httpie reads", () => {
    for (const call of [`http ${URL}`, `http GET ${URL} a==b`, `http GET ${URL} a=b`, `http ${URL} Authorization:x`, `https -v api.example.com/x q==1`]) {
      expect(httpWrite(call)).toEqual({ call, http: false });
    }
  });
});
