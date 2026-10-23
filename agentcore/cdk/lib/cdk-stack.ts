import { AgentCoreApplication, type AgentCoreApplicationProps } from '@aws/agentcore-cdk';
import { Stack, type StackProps, SecretValue } from 'aws-cdk-lib';
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
    moderator.addEnvironmentVariable('DECIDER_URL', 'http://your-decider-host/v1/systemone');
    moderator.addEnvironmentVariable('DECIDER_MODEL', 'strands-decider');

    // Secrets from SSM — resolved at deploy time, never in git
    const deciderKey = SecretValue.ssmSecure('/overseer/DECIDER_KEY').unsafeUnwrap();
    const tsAuthKey  = SecretValue.ssmSecure('/overseer/TS_AUTHKEY').unsafeUnwrap();
    const tsState    = SecretValue.ssmSecure('/overseer/TS_STATE').unsafeUnwrap();

    moderator.addEnvironmentVariable('DECIDER_KEY', deciderKey);
    moderator.addEnvironmentVariable('TS_AUTHKEY',  tsAuthKey);
    moderator.addEnvironmentVariable('TS_STATE',    tsState);

    // Grant SSM read + KMS decrypt
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
