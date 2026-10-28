import { AgentCoreApplication, type AgentCoreApplicationProps } from '@aws/agentcore-cdk';
import { Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface AgentCoreStackProps extends StackProps {
  application: AgentCoreApplicationProps;
}

export class AgentCoreStack extends Stack {
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);
    this.application = new AgentCoreApplication(this, 'Application', props.application);

    const moderator = this.application.runtime('moderator');

    // Non-secret env vars
    moderator.addEnvironmentVariable('PORT', '8080');
    moderator.addEnvironmentVariable('DECIDER_URL', 'http://supply.penguin-piano.ts.net/v1/systemone');
    moderator.addEnvironmentVariable('DECIDER_MODEL', 'strands-decider');

    // Pass SSM parameter paths — the app reads the values at startup via the ssm:GetParameter grant below.
    // AgentCore Runtime does not support {{resolve:ssm-secure:...}} dynamic references in env vars.
    moderator.addEnvironmentVariable('DECIDER_KEY_PARAM',  '/overseer/DECIDER_KEY');
    moderator.addEnvironmentVariable('TS_AUTHKEY_PARAM',   '/overseer/TS_AUTHKEY');
    moderator.addEnvironmentVariable('TS_STATE_PARAM',     '/overseer/TS_STATE');

    // Grant SSM read + KMS decrypt so the runtime can fetch SecureString values at startup
    moderator.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/overseer/*`],
    }));
    moderator.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }));
  }
}
