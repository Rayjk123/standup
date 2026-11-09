import { describe, expect, test } from "bun:test";
import {
  accountIdsRedactedFor,
  findRedactions,
  redactOptionsFor,
  redactSecrets,
  redactSecretsWithCount,
  stricterRedactOptions,
  REDACTED,
  type RedactOptions,
  type RedactTier,
} from "./redact.js";

/** Options per placement: a project runbook gets the signature tier plus account ids, a personal or global doc the full tier. */
const SIG: RedactOptions = { tier: "signature" };
const PROJECT: RedactOptions = { tier: "signature", accountIds: true };
const FULL: RedactOptions = { tier: "full" };
const FULL_NO_ACCT: RedactOptions = { tier: "full", accountIds: false };
const ACCT: RedactOptions = { accountIds: true };

describe("redactSecrets — account ids", () => {
  test("are left alone unless the caller opts in", () => {
    for (const line of [
      "arn:aws:iam::123456789012:role/Admin",
      "Beta account 444455556666, us-west-2",
      "aws_account_id: 123456789012",
    ]) {
      expect(redactSecrets(line)).toBe(line);
      expect(redactSecrets(line, SIG)).toBe(line);
    }
  });

  test("are redacted in account context when opted in: ARNs, labels, --account", () => {
    for (const opts of [ACCT, FULL]) {
      expect(redactSecrets("arn:aws:iam::123456789012:role/Admin", opts)).toBe(`arn:aws:iam::${REDACTED}:role/Admin`);
      expect(redactSecrets("acct 123456789012 done", opts)).toBe(`acct ${REDACTED} done`);
      expect(redactSecrets("Personal dev account: `111122223333`", opts)).toBe(`Personal dev account: \`${REDACTED}\``);
      expect(redactSecrets("cloud-creds login --account 111122223333 --role Admin", opts)).toBe(
        `cloud-creds login --account ${REDACTED} --role Admin`
      );
      expect(redactSecrets("aws_account_id=123456789012", opts)).toBe(`aws_account_id=${REDACTED}`);
      expect(redactSecrets("AccountId: 1234-5678-9012", opts)).toBe(`AccountId: ${REDACTED}`);
      expect(redactSecrets("account id 123456789012", opts)).toBe(`account id ${REDACTED}`);
    }
  });

  test("account context in prose, owner fields and ECR registry hosts", () => {
    const cases: Array<[string, string]> = [
      ["my personal account is 111122223333", `my personal account is ${REDACTED}`],
      ["the account was 123456789012.", `the account was ${REDACTED}.`],
      ["account number: 123456789012", `account number: ${REDACTED}`],
      ['"OwnerId": "123456789012"', `"OwnerId": "${REDACTED}"`],
      [
        "docker pull 123456789012.dkr.ecr.us-west-2.amazonaws.com/app:latest",
        `docker pull ${REDACTED}.dkr.ecr.us-west-2.amazonaws.com/app:latest`,
      ],
    ];
    for (const [text, expected] of cases) {
      expect(redactSecrets(text, ACCT)).toBe(expected);
      expect(redactSecrets(text, FULL)).toBe(expected);
      expect(redactSecrets(text)).toBe(text);
    }
  });

  test("a bare 12-digit number with no account context is not an account id", () => {
    for (const line of ["deploy 123456789012 now", "ts 202601010000", "ts 1727740800000 and port 5432"]) {
      expect(redactSecrets(line, FULL)).toBe(line);
    }
  });

  test("a configured personal id is redacted wherever it stands alone", () => {
    const opts = { accountIds: true, knownAccountIds: ["111122223333"] };
    expect(redactSecrets("| dev | 111122223333 |", opts)).toBe(`| dev | ${REDACTED} |`);
    expect(redactSecrets("dashed 1111-2222-3333 here", opts)).toBe(`dashed ${REDACTED} here`);
    expect(redactSecrets("not 1111122223333 or 111122223333-x", opts)).toBe("not 1111122223333 or 111122223333-x");
    expect(redactSecrets("| dev | 111122223333 |", { knownAccountIds: ["111122223333"] })).toBe("| dev | 111122223333 |");
    expect(redactSecrets("| dev | 111122223333 |", { tier: "full", knownAccountIds: ["111122223333"] })).toBe(`| dev | ${REDACTED} |`);
  });

  test("which docs get the full tier: personal layer and global content only", () => {
    expect(accountIdsRedactedFor({ scope: "user", projectId: "p" })).toBe(true);
    expect(accountIdsRedactedFor({ scope: "global", projectId: "p" })).toBe(true);
    expect(accountIdsRedactedFor({ scope: "project", projectId: "global" })).toBe(true);
    expect(
      accountIdsRedactedFor({ scope: "project", projectId: "p", sourceKind: "native-memory", slug: "native-mem-home-claude-md" })
    ).toBe(true);
    expect(accountIdsRedactedFor({ scope: "project", projectId: "p", sourceKind: "runbook", slug: "deploy" })).toBe(false);
    expect(accountIdsRedactedFor({ projectId: "p" })).toBe(false);
  });

  test("a project runbook's account ids and ARNs are redacted under project-scope redaction", () => {
    const runbook =
      "ExampleService's Beta account is `444455556666`, region us-west-2.\n" +
      "cloud-creds login --account 444455556666 --role ReadOnly\n" +
      "Role: arn:aws:iam::444455556666:role/Admin\n" +
      "Image: 444455556666.dkr.ecr.us-west-2.amazonaws.com/app:latest";
    const opts = redactOptionsFor({ scope: "project", projectId: "example-service", sourceKind: "runbook" });
    const { text, redactions } = redactSecretsWithCount(runbook, opts);
    expect(redactions).toBe(4);
    expect(text).not.toContain("444455556666");
    expect(text).toContain(`arn:aws:iam::${REDACTED}:role/Admin`);
    expect(text).toContain("region us-west-2");
  });

  test("project-scope redaction leaves bare 12-digit numbers with no account context", () => {
    const opts = redactOptionsFor({ scope: "project", projectId: "example-service" });
    for (const line of ["deploy 123456789012 now", "ts 202601010000", "order 123456789012 shipped"]) {
      expect(redactSecrets(line, opts)).toBe(line);
    }
  });
});

describe("redactOptionsFor — the tier follows the placement", () => {
  test("full for the personal layer and global content, signature plus account ids for project-scoped docs", () => {
    expect(redactOptionsFor({ scope: "user", projectId: "p" })).toEqual(FULL);
    expect(redactOptionsFor({ scope: "global", projectId: "p" })).toEqual(FULL);
    expect(redactOptionsFor({ projectId: "global" })).toEqual(FULL);
    expect(redactOptionsFor({ projectId: "p", sourceKind: "native-memory", slug: "native-mem-home-rules-x" })).toEqual(FULL);
    expect(redactOptionsFor({ scope: "project", projectId: "p", sourceKind: "runbook" })).toEqual(PROJECT);
    expect(redactOptionsFor({ projectId: "p" })).toEqual(PROJECT);
  });

  test("the default with no options is the signature tier", () => {
    const text = "password: hunter2very and token ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(text)).toBe(redactSecrets(text, SIG));
    expect(redactSecrets(text)).toBe(`password: hunter2very and token ${REDACTED}`);
  });

  test("the stricter of two placements is full when either is", () => {
    expect(stricterRedactOptions(SIG, FULL)).toEqual(FULL);
    expect(stricterRedactOptions(FULL, SIG)).toEqual(FULL);
    expect(stricterRedactOptions(SIG, SIG)).toEqual(SIG);
    expect(stricterRedactOptions(PROJECT, FULL)).toEqual(FULL);
    expect(stricterRedactOptions(SIG, PROJECT)).toEqual(PROJECT);
    expect(stricterRedactOptions(PROJECT, PROJECT)).toEqual(PROJECT);
  });
});

/**
 * Real secrets in the shapes they take in docs, each with the exact secret
 * substrings that must not survive, and the tier that catches it:
 *  - "signature": a high-precision format, redacted in every doc, project
 *    runbooks included;
 *  - "full": a heuristic credential shape, redacted in personal-layer and
 *    global content and deliberately left in project-scoped docs, where the
 *    same shapes are team data more often than secrets (the precision trade-off).
 */
const LEAKS: ReadonlyArray<{ text: string; secrets: readonly string[]; tier: RedactTier }> = [
  { tier: "signature", text: "Server=db;User Id=admin;Password=Hunter2pass;", secrets: ["Hunter2pass"] },
  { tier: "signature", text: "user=admin;password=Tr0ub4dor&3", secrets: ["Tr0ub4dor", "&3"] },
  { tier: "signature", text: "jdbc:sqlserver://db:1433;databaseName=app;user=sa;password=Sq1Pass!word;", secrets: ["Sq1Pass!word"] },
  { tier: "signature", text: "Driver={ODBC Driver 18};Server=db;Uid=sa;Pwd={p@ss;w0rd};", secrets: ["p@ss", "w0rd"] },
  {
    tier: "signature",
    text: "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo=;EndpointSuffix=core.windows.net",
    secrets: ["Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo="],
  },
  { tier: "signature", text: "curl -u admin:Hunter2pass https://api.internal/v1", secrets: ["Hunter2pass"] },
  { tier: "signature", text: "curl -s --user deploy:S3cr3tDeploy https://ci", secrets: ["S3cr3tDeploy"] },
  { tier: "signature", text: 'curl -H "Authorization: Bearer abc123def456ghi789jkl" https://api', secrets: ["abc123def456ghi789jkl"] },
  { tier: "signature", text: '{"headers": {"Authorization": "Basic dXNlcjpodW50ZXIy"}}', secrets: ["dXNlcjpodW50ZXIy"] },
  { tier: "signature", text: "token ya29.a0AfH6SMBx3dLkq9Z_example-ish-token-value", secrets: ["ya29.a0AfH6SMBx3dLkq9Z"] },
  {
    tier: "signature",
    text: "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF0abcdEFGH1234\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----",
    secrets: ["lQOYBF0abcdEFGH1234"],
  },
  { tier: "signature", text: "GITLAB_TOKEN glpat-Ab12Cd34Ef56Gh78Ij90", secrets: ["glpat-Ab12Cd34Ef56Gh78Ij90"] },
  {
    tier: "signature",
    text: "//registry.npmjs.org/:_authToken npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    secrets: ["npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"],
  },
  { tier: "signature", text: "stripe key sk_live_4eC39HqLyjWDarjtT1zdp7dc", secrets: ["sk_live_4eC39HqLyjWDarjtT1zdp7dc"] },
  {
    tier: "signature",
    text: "SENDGRID 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",
    secrets: ["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"],
  },
  {
    tier: "signature",
    text: "aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENGbPxRfiCYzzzzKEY12345",
    secrets: ["wJalrXUtnFEMIK7MDENGbPxRfiCYzzzzKEY12345"],
  },
  { tier: "signature", text: '"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzzzKEY123"', secrets: ["wJalrXUtnFEMI/K7MDENG"] },
  {
    tier: "signature",
    text: ["Access key ID,Secret access key", "AKIAZ7Q3EXAMPLE4ABCD,wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzzzKEY123"].join("\n"),
    secrets: ["AKIAZ7Q3EXAMPLE4ABCD", "wJalrXUtnFEMI/K7MDENG"],
  },
  { tier: "signature", text: "Authorization: Basic dXNlcjpwYXNzd29yZA==", secrets: ["dXNlcjpwYXNzd29yZA=="] },
  { tier: "signature", text: "GOOGLE AIzaSyA1234567890abcdefghijklmnopqrstuv", secrets: ["AIzaSyA1234567890abcdefghijklmnopqrstuv"] },
  { tier: "signature", text: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIbPxRfiCYEXAMPLEKEYVALUE", secrets: ["wJalrXUtnFEMIbPxRfiCYEXAMPLEKEYVALUE"] },
  { tier: "signature", text: "aws-secret-access-key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzzzKEY123", secrets: ["wJalrXUtnFEMI/K7MDENG"] },
  { tier: "signature", text: "AWS Secret Access Key [None]: wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzzzKEY123", secrets: ["wJalrXUtnFEMI/K7MDENG"] },
  { tier: "signature", text: "key sk-proj-abc_def-ghijklmnopqrstuvwxyz0123 end", secrets: ["abc_def", "ghijklmnopqrstuvwxyz0123"] },
  {
    tier: "signature",
    text: "tls:\n  key: |\n    -----BEGIN RSA PRIVATE KEY-----\n    MIIEowIBAAKCAQEAx1y2z3\n    abcDEF0123456789+/==",
    secrets: ["MIIEowIBAAKCAQEAx1y2z3", "abcDEF0123456789"],
  },
  {
    tier: "signature",
    text: String.raw`{"private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nhkiG9w0BAQEFAASC"}`,
    secrets: ["MIIEvQIBADANBgkq", "hkiG9w0BAQEFAASC"],
  },
  { tier: "signature", text: "curl -s \\\n  -u admin:S3cretPass \\\n  https://api.internal", secrets: ["S3cretPass"] },
  { tier: "signature", text: "Server=db;Password=Changeme123!;", secrets: ["Changeme123!"] },
  { tier: "signature", text: "postgres://u:Dummy2024x@db:5432/app", secrets: ["Dummy2024x"] },
  {
    tier: "full",
    text: String.raw`"SecretString": "{\"username\":\"admin\",\"password\":\"Hunter2Real!\"}"`,
    secrets: ["Hunter2Real!"],
  },
  { tier: "full", text: "db:\n  password: |\n    Hunter2RealPass\n  host: db", secrets: ["Hunter2RealPass"] },
  {
    tier: "full",
    text: "tls:\n  private_key: >-\n    MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n    BKcwggSjAgEAAoIBAQC7\n  cert: tls.crt",
    secrets: ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIBAQC7"],
  },
  { tier: "full", text: "The db password: Tr0ub4dor&3", secrets: ["Tr0ub4dor", "&3"] },
  { tier: "full", text: "env: PASSWORD=S3cretPass!", secrets: ["S3cretPass!"] },
  { tier: "full", text: "note:PGPASSWORD=pgS3cr3t psql -h db", secrets: ["pgS3cr3t"] },
  { tier: "full", text: "options: {password: 'opt1onSecret'}", secrets: ["opt1onSecret"] },
  { tier: "full", text: "config=host:x,password:c0nfigPass", secrets: ["c0nfigPass"] },
  { tier: "full", text: "https://x.com/api?password=hunter2&u=a", secrets: ["hunter2"] },
  { tier: "full", text: "https://api.x.com/v1/me?access_token=a1b2c3d4e5f6g7h8", secrets: ["a1b2c3d4e5f6g7h8"] },
  { tier: "full", text: "GET /v2/items?api_key=Zx81kLmN0pQ2&limit=5", secrets: ["Zx81kLmN0pQ2"] },
  {
    tier: "full",
    text: "https://bucket.s3.amazonaws.com/k?X-Amz-Signature=9f8e7d6c5b4a39281706f5e4d3c2b1a0&X-Amz-Expires=300",
    secrets: ["9f8e7d6c5b4a39281706f5e4d3c2b1a0"],
  },
  { tier: "full", text: "psql --password hunter2 --host db", secrets: ["hunter2"] },
  { tier: "full", text: "tool --client-secret=Q9w8E7r6T5y4U3i2O1p0 --verbose", secrets: ["Q9w8E7r6T5y4U3i2O1p0"] },
  { tier: "full", text: "mysql -u root -pS3cret mydb", secrets: ["S3cret"] },
  { tier: "full", text: "passphrase: correct horse battery staple", secrets: ["correct", "horse", "battery", "staple"] },
  { tier: "full", text: "PGPASSWORD=hunter2very", secrets: ["hunter2very"] },
  { tier: "full", text: "export DB_PASS=hunter2", secrets: ["hunter2"] },
  { tier: "full", text: "secret = a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", secrets: ["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"] },
  { tier: "full", text: "GITHUB_TOKEN=ghx0Zr8Lq2Vn5Tb7Wc9Yd1Fe3Hg6", secrets: ["ghx0Zr8Lq2Vn5Tb7Wc9Yd1Fe3Hg6"] },
  { tier: "full", text: '"apiKey": "kq83JdLs92mXz01PqRt7VbN4"', secrets: ["kq83JdLs92mXz01PqRt7VbN4"] },
  { tier: "full", text: "spring.datasource.password=Spr1ngPass", secrets: ["Spr1ngPass"] },
  { tier: "full", text: "Set `password: hunter2` in config", secrets: ["hunter2"] },
  { tier: "full", text: "SQL_PASSWORD=abc;Server=prod", secrets: ["abc;"] },
  { tier: "full", text: "env:\n  - name: DB_PASSWORD\n    value: hunter2kube", secrets: ["hunter2kube"] },
  { tier: "full", text: '{"Name": "DB_PASSWORD", "Value": "hunter2ecs"}', secrets: ["hunter2ecs"] },
  { tier: "full", text: String.raw`{"password": "hun\"ter2"}`, secrets: ["hun", "ter2"] },
  { tier: "full", text: "password: Hunter2-Your-Pass", secrets: ["Hunter2"] },
  { tier: "full", text: 'the password is "s3cr3t pass"', secrets: ["s3cr3t"] },
];

/**
 * Team data, references and placeholders that look like credential
 * assignments but are not: every one must come back byte-identical in a
 * project doc (signature tier) AND in a personal or global doc (full tier).
 */
const TEAM_DATA: readonly string[] = [
  "partition_key: bundleId",
  "sortKey: createdAt",
  "cacheKey: projectId",
  "nextToken = resp.NextToken",
  "passwordPolicy: strict",
  "request id 550e8400-e29b-41d4-a716-123456789012",
  "123e4567-1234-5678-9012-444455556666",
  "test card 4111-1111-1111-1111",
  "built at 202601010000",
  "max_tokens: 4096",
  "Primary key: session identifier",
  "token: the next lexical token",
  '"sortKey": "createdAt"',
  "TOKEN_FILE=/etc/token",
  "kms_key_id: 1234abcd-12ab-34cd-56ef-1234567890ab",
  "keyId: alias/aws/s3",
  "partitionKey: tenant-42",
  "primaryKey: user_id2",
  "sortKey: version#0001",
  "s3_key: data/2026/10/file.parquet",
  "objectKey: assets/logo2x.png",
  "region_key: us-west-2",
  "ssh_key: id_ed25519",
  "hash_key: a1b2c3d4e5f6",
  "key: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "idempotencyKey: req-2026-10-05",
  '"cacheKey": "user:123:profile"',
  "AUTH=sigv4",
  '"apiKey": "YOUR_API_KEY"',
  "API_KEY=your-key-here",
  "api_key: <your-key>",
  "apiKey: string",
  "API_TOKEN=${API_TOKEN}",
  "password: process.env.DB_PASSWORD",
  "client_secret: ***",
  "authToken?: undefined",
  "cache_write_input_tokens: 12345",
  "existingSecret: db-credentials",
  "secretName: prod/app/db",
  "Password: must be 12+ characters",
  "password: !Ref DbPassword",
  "docker login --password-stdin",
  "pageToken: CgsIARIHMTIzNDU2Nw",
  "access_key: AKIA-placeholder-xxxx",
  "aws_kms_key: arn:aws:kms:us-west-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
  "password: changeme",
  "password: <your-password>",
  "client_secret: example-secret",
  "DB_PASSWORD=%DB_PASSWORD%",
  "api_key: xxxxxxxxxxxxxxxxxxxxxxxx",
  // A separator never crosses a line break, so an empty value never takes the next line.
  "DB_PASSWORD=\nDB_HOST=localhost",
  "password:\n  min_length: 12\n  require_symbols: true",
  "secretKeys:\n  adminPasswordKey: postgres-password\n  userPasswordKey: password",
  // Code and references: a call, `await`/`new`, a dotted identifier chain, a template.
  'const password = form.get("password")',
  'password = os.getenv("DB_PASSWORD")',
  "user.password = await bcrypt.hash(pw, 10)",
  "secret = new Secret(this, 'DbSecret')",
  "password = var.db_password",
  "password = local.db_password",
  "password = random_password.db.result",
  "db_password: data.aws_ssm_parameter.db.value",
  "let x = config.db.password",
  "password: ${{ secrets.DB_PASSWORD }}",
  'password: "${{ secrets.DB_PASSWORD }}"',
  "MasterUserPassword: '{{resolve:secretsmanager:MySecret:SecretString:password}}'",
  'password: ""',
  "password: YOUR_PASSWORD",
  "postgres://user:${DB_PASSWORD}@db:5432/app",
  "postgres://user:password@localhost:5432/app",
  "Server=db;User Id=app;Password=${DB_PASSWORD};",
  "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY",
  "curl -u $USER:$TOKEN https://api.internal",
  'curl -u "ci:${API_TOKEN}" https://api.internal',
  "curl -u user:password https://example.com",
  "Authorization: Bearer <token>",
  "Authorization: Basic <base64(user:pass)>",
  "Authorization: Basic YWRtaW4",
  "secretAccessKeyFromSecretsManager: true",
  "SecretAccessKey: AccessKeySecretAccessKeyOutput",
  "Authorization: Bearer token123",
  "Authorization: Bearer v2-token",
  "Use `curl -u user:password` to test the endpoint",
  // Templates, parameters and prose in a connection string.
  "Server=x;Pwd={{resolve:secretsmanager:Db:SecretString:password}};",
  "Server=x;password={{ .Values.db.password }};",
  "Server=x;Password={{password}};",
  "Server=x;Password=[parameters('dbPassword')];",
  "Server=x;Password=#{Octopus.Db.Password};",
  "Server=x;Password=__DB_PASSWORD__;",
  "Server=x;Password=@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/db);",
  'String.format("Server=%s;Password=%s;", host, pw)',
  "Server=x;Password={0};",
  "Server=x;Password=?;",
  "Server=x;Password=@DbPassword;",
  "Server=x;Password=:dbpassword;",
  "Server=x;Password=see vault;",
  "Use Password= with a strong value; MinLength=12",
  // A BEGIN line with no key body after it.
  "```\n-----BEGIN OPENSSH PRIVATE KEY-----\n```",
  "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nNote: the file is encrypted\nNext: convert it",
  // Code: operators, indexes, annotations, identifiers and query parameters.
  "const password = process.env.DB_PASSWORD!;",
  'password = config["db"]["password"]',
  "client_secret = credentials['client_secret']",
  'password := os.Getenv("DB_PASSWORD")',
  "if password == confirm {",
  "if (password === confirm) return;",
  "password: str = Field(..., min_length=12)",
  "password: Optional[str] = None",
  "def login(user, password: str):",
  "const user = { password: hashed };",
  'payload = {"password": pw}',
  "WHERE password = $1",
  "WHERE password = ?",
  "WHERE password = :password",
  "cursor.execute(q, password = %s)",
  // Secret-store references and constants.
  "password: ENC[AES256_GCM,data:abc,iv:def,tag:ghi,type:str]",
  "password: vault:secret/data/db#password",
  "password: ref+awssecrets://db/password",
  "password: arn:aws:secretsmanager:us-west-2:111122223333:secret:db",
  "secret_key: SECRET_KEY",
  "password: ~",
  "the password is case-sensitive",
  // Prose and system files.
  "/etc/passwd: root:x:0:0:root:/root:/bin/bash",
  "Bearer authentication is required on every route",
  "PIN is 0000 on the test terminals",
  "the password is required on first login",
];

describe("redactSecrets — leaked secret shapes are redacted in the tier that owns them", () => {
  test.each(LEAKS.map((c) => [c.text, c.secrets, c.tier] as const))("%s", (text, secrets, tier) => {
    const tiers = tier === "signature" ? [SIG, FULL, {}] : [FULL];
    for (const opts of tiers) {
      const out = redactSecrets(text, opts);
      expect(out).toContain(REDACTED);
      for (const secret of secrets) expect(out).not.toContain(secret);
    }
    // A heuristic shape is left in a project-scoped doc: the precision trade-off.
    if (tier === "full") expect(redactSecrets(text, SIG)).toBe(text);
  });

  test("the text around a redacted value survives", () => {
    expect(redactSecrets("Server=db;User Id=admin;Password=Hunter2pass;", SIG)).toBe(`Server=db;User Id=admin;Password=${REDACTED};`);
    expect(redactSecrets("user=admin;password=Tr0ub4dor&3", SIG)).toBe(`user=admin;password=${REDACTED}`);
    expect(redactSecrets("Driver={x};Server=db;Uid=sa;Pwd={p@ss;w0rd};", SIG)).toBe(`Driver={x};Server=db;Uid=sa;Pwd=${REDACTED};`);
    expect(redactSecrets("curl -u admin:Hunter2pass https://h", SIG)).toBe(`curl -u admin:${REDACTED} https://h`);
    expect(redactSecrets("note:PGPASSWORD=pgS3cr3t psql -h db", FULL)).toBe(`note:PGPASSWORD=${REDACTED} psql -h db`);
    expect(redactSecrets("https://x.com/api?password=hunter2&u=a", FULL)).toBe(`https://x.com/api?password=${REDACTED}&u=a`);
    expect(redactSecrets("passphrase: correct horse battery staple", FULL)).toBe(`passphrase: ${REDACTED}`);
    expect(redactSecrets("password: hunter2 # rotated monthly", FULL)).toBe(`password: ${REDACTED} # rotated monthly`);
    expect(redactSecrets("password: hunter2 user: admin", FULL)).toBe(`password: ${REDACTED} user: admin`);
    expect(redactSecrets("mysql -u root -pS3cret mydb", FULL)).toBe(`mysql -u root -p${REDACTED} mydb`);
    expect(redactSecrets("The db password: Tr0ub4dor&3", FULL)).toBe(`The db password: ${REDACTED}`);
    expect(redactSecrets("my password is Hunter22!", FULL)).toBe(`my password is ${REDACTED}`);
    expect(redactSecrets("key:\n  -----BEGIN RSA PRIVATE KEY-----\n  MIIEowIBAAKCAQEAx1y2z3\n\nAfter.", SIG)).toBe(`key:\n  ${REDACTED}\n\nAfter.`);
    expect(redactSecrets(String.raw`{\"user\":\"admin\",\"password\":\"Hunter2Real!\"}`, FULL)).toBe(
      String.raw`{\"user\":\"admin\",\"password\":\"` + REDACTED + String.raw`\"}`
    );
  });

  test("a YAML block scalar loses its indented body and keeps the next key", () => {
    expect(redactSecrets("db:\n  password: |\n    Hunter2RealPass\n    second line\n\n  host: db\n", FULL)).toBe(
      `db:\n  password: |\n    ${REDACTED}\n\n  host: db\n`
    );
    expect(redactSecrets("password: >-\n  folded secret\nnext: 1", FULL)).toBe(`password: >-\n  ${REDACTED}\nnext: 1`);
    expect(redactSecrets("password: |\nnext: 1", FULL)).toBe("password: |\nnext: 1");
  });
});

describe("redactSecrets — team data, references and placeholders are untouched", () => {
  test.each(TEAM_DATA.map((line) => [line] as const))("%s", (line) => {
    expect(redactSecrets(line)).toBe(line);
    expect(redactSecrets(line, SIG)).toBe(line);
    expect(redactSecrets(line, FULL_NO_ACCT)).toBe(line);
    if (!line.includes("arn:")) expect(redactSecrets(line, FULL)).toBe(line);
  });

  test("a project runbook made of credential-shaped team lines survives project-scope redaction, but for its ARNs' accounts", () => {
    const runbook = TEAM_DATA.join("\n");
    const opts = redactOptionsFor({ scope: "project", projectId: "example-service", sourceKind: "runbook", slug: "deploy" });
    expect(opts).toEqual(PROJECT);
    expect(redactSecrets(runbook, opts)).toBe(runbook.replace(/(arn:aws:[a-z]+:us-west-2:)111122223333:/g, `$1${REDACTED}:`));
  });
});

describe("redactSecrets — runs in linear time on adversarial input", () => {
  test.each([
    ["'pwd=a' ", 7000],
    ["password=a ", 5000],
    ["Server=x;Password=a;", 2500],
    ["a.", 25000],
    ["password: a ", 4000],
    ["-----BEGIN RSA PRIVATE KEY-----\n", 1500],
  ] as const)("%p × %p", (unit, times) => {
    const text = unit.repeat(times);
    for (const opts of [SIG, FULL]) {
      const started = performance.now();
      redactSecrets(text, opts);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
});

/**
 * Shapes neither tier catches, kept as known gaps of a defense-in-depth
 * redactor: personal-layer docs never leave their owner's scope regardless.
 */
describe("redactSecrets — known gaps", () => {
  test.todo('XML: <password>…</password> and <property name="password" value="…"/>', () => {});
  test.todo("URL-encoded JSON: %22password%22%3A%22…%22", () => {});
  test.todo("netrc: machine host login user password …", () => {});
  test.todo("api_key values under 20 characters and UUID-shaped API keys (Heroku)", () => {});
});

describe("redactSecrets — secret shapes", () => {
  test("provider tokens and keys, in every tier", () => {
    const cases = [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
      "xoxb-123456789012-abcdefghijklmnop",
      "xapp-1-A0123456789-abcdefghijklmnop",
      "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX",
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    ];
    for (const token of cases) {
      for (const opts of [SIG, FULL]) {
        const out = redactSecrets(`here: ${token} end`, opts);
        expect(out).not.toContain(token);
        expect(out).toContain(REDACTED);
      }
    }
  });

  test("private keys, URL credentials, bearer and basic auth headers, in every tier", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
    for (const opts of [SIG, FULL]) {
      expect(redactSecrets(`key:\n${pem}\n`, opts)).toBe(`key:\n${REDACTED}\n`);
      expect(redactSecrets("postgres://admin:s3cr3tpass@db:5432/app", opts)).toBe(`postgres://admin:${REDACTED}@db:5432/app`);
      expect(redactSecrets("Authorization: Bearer abcdefgh12345678", opts)).toBe(`Authorization: Bearer ${REDACTED}`);
      expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==", opts)).toBe(`Authorization: Basic ${REDACTED}`);
    }
  });

  test("credential assignments in the full tier", () => {
    expect(redactSecrets('client_secret = "a b c d"', FULL)).toBe(`client_secret = "${REDACTED}"`);
    expect(redactSecrets("password: 12345678", FULL)).toBe(`password: ${REDACTED}`);
    expect(redactSecrets("PGPASSWORD=hunter2very", FULL)).toBe(`PGPASSWORD=${REDACTED}`);
    expect(redactSecrets("export DB_PASS=hunter2", FULL)).toBe(`export DB_PASS=${REDACTED}`);
    expect(redactSecrets("secret = a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", FULL)).toBe(`secret = ${REDACTED}`);
    expect(redactSecrets("api_token: a1b2c3d4e5f6a7b8c9d0e1f2", FULL)).toBe(`api_token: ${REDACTED}`);
    expect(redactSecrets('client_secret: "k3y with spaces"', FULL)).toBe(`client_secret: "${REDACTED}"`);
  });

  test("spans report offsets and the rule name, never the value", () => {
    const text = "x password: hunter2very\ny";
    const spans = findRedactions(text, FULL);
    expect(spans).toEqual([{ start: 12, end: 23, pattern: "credential-assignment" }]);
    expect(JSON.stringify(spans)).not.toContain("hunter2very");
    expect(findRedactions(text, SIG)).toEqual([]);
  });

  test("counts redactions and is idempotent", () => {
    const text = "acct 123456789012, password: hunter2very, Bearer abcdefgh12345678";
    const first = redactSecretsWithCount(text, FULL);
    expect(first.redactions).toBe(3);
    expect(first.text).not.toContain("hunter2very");
    const second = redactSecretsWithCount(first.text, FULL);
    expect(second.redactions).toBe(0);
    expect(second.text).toBe(first.text);
  });
});

describe("redactSecrets — secrets outside a key: value shape", () => {
  test("a bare AWS-secret-shaped run in the full tier only, and never a git SHA, a path or a word run", () => {
    const line = "secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY here";
    expect(redactSecrets(line, FULL)).toBe(`secret ${REDACTED} here`);
    expect(redactSecrets(line, SIG)).toBe(line);
    for (const text of [
      "commit 3f2a9c1e0b7d4a6f8e5c2b1a0d9e8f7a6b5c4d3e is the fix",
      "see src/Components/Widgets/Button7Primary/x",
      "ThisIsAVeryLongIdentifierNameWithoutDigits",
    ]) {
      expect(redactSecrets(text, FULL)).toBe(text);
    }
  });

  test("a private key with no END line loses its body and keeps the text after it", () => {
    const out = redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx1y2z3\nabcDEF0123456789+/==\n\nAfter the key.");
    expect(out).not.toContain("MIIEow");
    expect(out).toEndWith("After the key.");
  });

  test("a password stated in prose, but not a description of one", () => {
    expect(redactSecrets("my password is hunter2, and the PIN was 'tiger'", FULL)).toBe(
      `my password is ${REDACTED}, and the PIN was '${REDACTED}'`
    );
    for (const line of ["the password is required on first login", "the PIN is 4 digits", "password is optional."]) {
      expect(redactSecrets(line, FULL)).toBe(line);
    }
  });

  test("account ids in spaced or dotted groups and run into a label, only in account context", () => {
    expect(redactSecrets("account 1111 2222 3333", ACCT)).toBe(`account ${REDACTED}`);
    expect(redactSecrets("account 1111.2222.3333", ACCT)).toBe(`account ${REDACTED}`);
    expect(redactSecrets("acct111122223333 and account_111122223333", ACCT)).toBe(`acct${REDACTED} and account_${REDACTED}`);
    for (const line of ["test card 4111 1111 1111 1111", "build_202601010000", "v 1234.5678.9012"]) {
      expect(redactSecrets(line, ACCT)).toBe(line);
    }
    const known = { accountIds: true, knownAccountIds: ["111122223333"] };
    expect(redactSecrets("role_111122223333 / 1111 2222 3333", known)).toBe(`role_${REDACTED} / ${REDACTED}`);
  });

  test("account ids in full-width digits, labeled or configured, at the full tier only", () => {
    const wide = "１１１１２２２２３３３３";
    expect(redactSecrets(`account ${wide}`, { tier: "full" })).toBe(`account ${REDACTED}`);
    expect(redactSecrets(`see ${wide} here`, { tier: "full", knownAccountIds: ["111122223333"] })).toBe(`see ${REDACTED} here`);
    expect(redactSecrets(`account ${wide}`, { tier: "signature" })).toBe(`account ${wide}`);
    // Outside an account rule full-width digits are left as written.
    expect(redactSecrets(`order ${wide} total`, { tier: "full" })).toBe(`order ${wide} total`);
  });

  test("account ids in four groups of three, labeled or configured", () => {
    expect(redactSecrets("account 111-122-223-333", ACCT)).toBe(`account ${REDACTED}`);
    expect(redactSecrets("acct id: 111 122 223 333", ACCT)).toBe(`acct id: ${REDACTED}`);
    const known = { accountIds: true, knownAccountIds: ["111122223333"] };
    expect(redactSecrets("see 111-122-223-333 and 111.122.223.333", known)).toBe(`see ${REDACTED} and ${REDACTED}`);
    // Unlabeled and unconfigured, a grouped number is left alone; so is one in a longer run.
    for (const line of ["call 555-123-456-789", "order 1111122223333 total"]) {
      expect(redactSecrets(line, ACCT)).toBe(line);
      expect(redactSecrets(line, known)).toBe(line);
    }
  });
});
