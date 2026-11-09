---
title: CDK templates over 50 KiB need --template-url
source_kind: runbook
scope: project
origin_class: agent
tags: [cdk, cloudformation, deploy]
---
# CDK templates over 50 KiB need --template-url

CloudFormation rejects a template passed inline in the request body when it is larger than 51,200 bytes. Large
synthesized stacks hit this on a local deploy:

```
Templates with a size greater than 51,200 bytes must be deployed via an S3 Bucket
```

## Fix

1. Synthesize: `npx cdk synth MyStack > /tmp/MyStack.template.json`.
2. Upload: `aws s3 cp /tmp/MyStack.template.json s3://<staging-bucket>/templates/MyStack.template.json`.
3. Update with a URL instead of a body:
   `aws cloudformation update-stack --stack-name MyStack --template-url https://<staging-bucket>.s3.amazonaws.com/templates/MyStack.template.json --capabilities CAPABILITY_NAMED_IAM --parameters file://params.json`.

`cdk deploy` does this automatically when the bootstrap stack provides a staging bucket; the problem only shows up
when packaging by hand. Keep the parameters file next to the template so the packaging params match the synth.
