// Provisions every AWS resource on Floci (http://localhost:4566).
// Idempotent: safe to re-run at any time (creates what is missing, updates
// secrets/policies). Usage: npm run provision
//
// Resources (owner in brackets):
//   S3            esp-frontend (shared web), esp-roster-uploads [Nour],
//                 esp-hall-layouts [Rishi], esp-seatmap-exports [Attallah]
//   DynamoDB      EspHolidayCache [Nour], EspRevokedTokens [Rishi]
//   SNS           esp-domain-events (halls + exams publish)
//   SQS           esp-allocation-events + DLQ [Attallah consumes]
//   EventBridge   esp-audit-bus -> rule -> CloudWatch /esp/audit-events
//   Secrets Mgr   esp/jwt, esp/calendarific, esp/db/<service>
//   IAM           one least-privilege role per service
//   CloudWatch    log groups, metric filters, alarms
//   ELBv2 + ECS   ALB with path rules + one ECS service per microservice
//                 (control plane only on Floci, as in Lab 8)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { AWS, ACCOUNT_ID, REGION, RESOURCES, PORTS, CORS_ORIGINS } = require('../shared/config');

const S3 = require('@aws-sdk/client-s3');
const DDB = require('@aws-sdk/client-dynamodb');
const SQS = require('@aws-sdk/client-sqs');
const SNS = require('@aws-sdk/client-sns');
const EB = require('@aws-sdk/client-eventbridge');
const SM = require('@aws-sdk/client-secrets-manager');
const IAM = require('@aws-sdk/client-iam');
const CWL = require('@aws-sdk/client-cloudwatch-logs');
const CW = require('@aws-sdk/client-cloudwatch');
const ELB = require('@aws-sdk/client-elastic-load-balancing-v2');
const ECS = require('@aws-sdk/client-ecs');
const EC2 = require('@aws-sdk/client-ec2');

const s3 = new S3.S3Client({ ...AWS, forcePathStyle: true });
const ddb = new DDB.DynamoDBClient(AWS);
const sqs = new SQS.SQSClient(AWS);
const sns = new SNS.SNSClient(AWS);
const eb = new EB.EventBridgeClient(AWS);
const sm = new SM.SecretsManagerClient(AWS);
const iam = new IAM.IAMClient(AWS);
const cwl = new CWL.CloudWatchLogsClient(AWS);
const cw = new CW.CloudWatchClient(AWS);
const elb = new ELB.ElasticLoadBalancingV2Client(AWS);
const ecs = new ECS.ECSClient(AWS);
const ec2 = new EC2.EC2Client(AWS);

const SERVICES = ['auth', 'halls', 'exams', 'allocation'];
const B = RESOURCES.buckets;
const arn = {
  bucket: (b) => `arn:aws:s3:::${b}`,
  table: (t) => `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${t}`,
  queue: (q) => `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${q}`,
  secret: (s) => `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${s}*`,
  logGroup: (g) => `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${g}:*`,
  bus: `arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/${RESOURCES.eventBus}`,
};

const EXISTS = /already|exist|InUse|Duplicate|AlreadyOwned/i;
async function ok(label, fn) {
  try { const r = await fn(); console.log(`  ✓ ${label}`); return r; } catch (e) {
    if (EXISTS.test(e.name) || EXISTS.test(e.message)) { console.log(`  = ${label} (exists)`); return null; }
    throw new Error(`${label}: ${e.name} ${e.message}`);
  }
}
async function warn(label, fn) {
  try { const r = await fn(); console.log(`  ✓ ${label}`); return r; } catch (e) { console.log(`  ! ${label} skipped (${e.name}: ${e.message.slice(0, 80)})`); return null; }
}

async function provisionS3() {
  console.log('S3');
  for (const b of Object.values(B)) await ok(`bucket ${b}`, () => s3.send(new S3.CreateBucketCommand({ Bucket: b })));
  // Frontend: static website, publicly readable (it holds no secrets)
  await ok('esp-frontend website config', () => s3.send(new S3.PutBucketWebsiteCommand({ Bucket: B.web, WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } } })));
  await warn('esp-frontend allow public policy', () => s3.send(new S3.DeletePublicAccessBlockCommand({ Bucket: B.web })));
  await warn('esp-frontend public-read policy', () => s3.send(new S3.PutBucketPolicyCommand({ Bucket: B.web, Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'PublicReadWebsite', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `${arn.bucket(B.web)}/*` }] }) })));
  // Private data buckets: block public access + encryption at rest
  for (const b of [B.rosters, B.layouts, B.seatmaps]) {
    await warn(`${b} block public access`, () => s3.send(new S3.PutPublicAccessBlockCommand({ Bucket: b, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } })));
    await warn(`${b} SSE-S3 encryption`, () => s3.send(new S3.PutBucketEncryptionCommand({ Bucket: b, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } })));
  }
  // Browser uploads roster CSVs directly with a short-lived presigned URL
  await warn('esp-roster-uploads CORS', () => s3.send(new S3.PutBucketCorsCommand({ Bucket: B.rosters, CORSConfiguration: { CORSRules: [{ AllowedOrigins: CORS_ORIGINS, AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], MaxAgeSeconds: 600 }] } })));
  await warn('esp-roster-uploads lifecycle (delete after 7 days)', () => s3.send(new S3.PutBucketLifecycleConfigurationCommand({ Bucket: B.rosters, LifecycleConfiguration: { Rules: [{ ID: 'expire-uploads', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 7 } }] } })));
}

async function provisionDynamo() {
  console.log('DynamoDB');
  const tables = [[RESOURCES.tables.holidayCache, 'cacheKey'], [RESOURCES.tables.revokedTokens, 'jti']];
  for (const [name, key] of tables) {
    await ok(`table ${name}`, () => ddb.send(new DDB.CreateTableCommand({ TableName: name, AttributeDefinitions: [{ AttributeName: key, AttributeType: 'S' }], KeySchema: [{ AttributeName: key, KeyType: 'HASH' }], BillingMode: 'PAY_PER_REQUEST', SSESpecification: { Enabled: true } })));
    await warn(`${name} TTL on expiresAt`, () => ddb.send(new DDB.UpdateTimeToLiveCommand({ TableName: name, TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' } })));
  }
}

async function provisionMessaging() {
  console.log('SQS + SNS');
  await ok(`queue ${RESOURCES.dlqName}`, () => sqs.send(new SQS.CreateQueueCommand({ QueueName: RESOURCES.dlqName, Attributes: { MessageRetentionPeriod: '1209600', SqsManagedSseEnabled: 'true' } })));
  await ok(`queue ${RESOURCES.queueName} (redrive to DLQ after 3 failures)`, () => sqs.send(new SQS.CreateQueueCommand({
    QueueName: RESOURCES.queueName,
    Attributes: { VisibilityTimeout: '30', SqsManagedSseEnabled: 'true', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn.queue(RESOURCES.dlqName), maxReceiveCount: '3' }) },
  })));
  await ok('topic esp-domain-events', () => sns.send(new SNS.CreateTopicCommand({ Name: 'esp-domain-events' })));
  await ok('queue policy: only the topic may send', () => sqs.send(new SQS.SetQueueAttributesCommand({
    QueueUrl: RESOURCES.queueUrl,
    Attributes: { Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: arn.queue(RESOURCES.queueName), Condition: { ArnEquals: { 'aws:SourceArn': RESOURCES.topicArn } } }] }) },
  })));
  const subs = await sns.send(new SNS.ListSubscriptionsByTopicCommand({ TopicArn: RESOURCES.topicArn }));
  if (!subs.Subscriptions?.some((s) => s.Endpoint === arn.queue(RESOURCES.queueName))) {
    await ok('subscribe queue to topic', () => sns.send(new SNS.SubscribeCommand({ TopicArn: RESOURCES.topicArn, Protocol: 'sqs', Endpoint: arn.queue(RESOURCES.queueName), Attributes: { RawMessageDelivery: 'true' } })));
  } else console.log('  = subscribe queue to topic (exists)');
}

async function provisionLogs() {
  console.log('CloudWatch Logs + metrics + alarms');
  const groups = ['gateway', ...SERVICES, 'audit-events'].map((s) => RESOURCES.logGroup(s));
  for (const g of groups) {
    await ok(`log group ${g}`, () => cwl.send(new CWL.CreateLogGroupCommand({ logGroupName: g })));
    await warn(`${g} retention 14d`, () => cwl.send(new CWL.PutRetentionPolicyCommand({ logGroupName: g, retentionInDays: 14 })));
  }
  const ns = RESOURCES.metricNamespace;
  const filters = [
    ['/esp/gateway', 'Unauthorized401', '{ $.event = "request" && $.status = 401 }', 'Unauthorized401'],
    ['/esp/gateway', 'Forbidden403', '{ $.event = "request" && $.status = 403 }', 'Forbidden403'],
    ['/esp/gateway', 'ServerErrors5xx', '{ $.event = "request" && $.status >= 500 }', 'ServerErrors5xx'],
    ['/esp/auth', 'FailedLogins', '{ $.event = "login_failed" }', 'FailedLogins'],
    // Auth hardening (Rishi): lockouts and rate-limited login bursts
    ['/esp/auth', 'AccountLockouts', '{ $.event = "account_locked" }', 'AccountLockouts'],
    ['/esp/auth', 'LoginRateLimited', '{ $.event = "login_rate_limited" }', 'LoginRateLimited'],
  ];
  for (const [group, name, pattern, metric] of filters) {
    await ok(`metric filter ${name}`, () => cwl.send(new CWL.PutMetricFilterCommand({ logGroupName: group, filterName: name, filterPattern: pattern, metricTransformations: [{ metricName: metric, metricNamespace: ns, metricValue: '1', defaultValue: 0 }] })));
  }
  const alarms = [
    ['ESP-FailedLogins-BruteForce', 'FailedLogins', 5, 'Possible password guessing: 5+ failed logins in 5 minutes'],
    ['ESP-Forbidden-Spike', 'Forbidden403', 10, 'Possible privilege probing: 10+ 403 responses in 5 minutes'],
    ['ESP-ServerErrors', 'ServerErrors5xx', 1, 'Any 5xx error from the API'],
    ['ESP-Unauthorized-Spike', 'Unauthorized401', 20, 'Possible token guessing/replay: 20+ 401 responses in 5 minutes'],
    ['ESP-AccountLockout', 'AccountLockouts', 1, 'An account was locked after 5 failed logins'],
    ['ESP-LoginRateLimited', 'LoginRateLimited', 1, 'An IP hit the login rate limit (10 failed attempts in 15 minutes)'],
  ];
  for (const [name, metric, threshold, desc] of alarms) {
    await ok(`alarm ${name}`, () => cw.send(new CW.PutMetricAlarmCommand({ AlarmName: name, AlarmDescription: desc, Namespace: ns, MetricName: metric, Statistic: 'Sum', Period: 300, EvaluationPeriods: 1, Threshold: threshold, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching' })));
  }
}

async function provisionEventBridge() {
  console.log('EventBridge');
  await ok(`bus ${RESOURCES.eventBus}`, () => eb.send(new EB.CreateEventBusCommand({ Name: RESOURCES.eventBus })));
  await ok('rule esp-audit-to-logs', () => eb.send(new EB.PutRuleCommand({ Name: 'esp-audit-to-logs', EventBusName: RESOURCES.eventBus, EventPattern: JSON.stringify({ source: ['esp.app'] }) })));
  await ok('target -> /esp/audit-events', () => eb.send(new EB.PutTargetsCommand({ Rule: 'esp-audit-to-logs', EventBusName: RESOURCES.eventBus, Targets: [{ Id: 'audit-log-group', Arn: `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/esp/audit-events` }] })));
}

async function putSecret(name, value) {
  const SecretString = JSON.stringify(value);
  try {
    await sm.send(new SM.CreateSecretCommand({ Name: name, SecretString }));
    console.log(`  ✓ secret ${name}`);
  } catch (e) {
    if (!EXISTS.test(e.name)) throw e;
    await sm.send(new SM.PutSecretValueCommand({ SecretId: name, SecretString }));
    console.log(`  = secret ${name} (value updated)`);
  }
}

async function provisionSecrets() {
  console.log('Secrets Manager (values read from backend/.env, never committed)');
  const need = (k) => { if (!process.env[k]) throw new Error(`${k} missing in backend/.env`); return process.env[k]; };
  await putSecret(RESOURCES.secrets.jwt, { secret: need('JWT_SECRET') });
  await putSecret(RESOURCES.secrets.calendarific, { apiKey: need('CALENDARIFIC_API_KEY') });
  const owner = new URL(need('DATABASE_URL'));
  for (const s of SERVICES) {
    const url = new URL(owner.href);
    url.username = `esp_${s}`;
    url.password = need(`DB_PASSWORD_${s.toUpperCase()}`);
    await putSecret(RESOURCES.secrets.db(s), { url: url.href });
  }
}

// One role per service, each with ONLY the actions/resources it uses.
function policyFor(service) {
  const st = [
    { Sid: 'OwnLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: arn.logGroup(RESOURCES.logGroup(service)) },
    { Sid: 'OwnDbSecret', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: [arn.secret(RESOURCES.secrets.db(service)), arn.secret(RESOURCES.secrets.jwt)] },
    { Sid: 'AuditEvents', Effect: 'Allow', Action: 'events:PutEvents', Resource: arn.bus },
  ];
  const publish = { Sid: 'PublishDomainEvents', Effect: 'Allow', Action: 'sns:Publish', Resource: RESOURCES.topicArn };
  if (service === 'auth') st.push({ Sid: 'RevokedTokens', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: arn.table(RESOURCES.tables.revokedTokens) });
  if (service === 'halls') st.push(publish, { Sid: 'LayoutExports', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: `${arn.bucket(B.layouts)}/*` });
  if (service === 'exams') {
    st.push(publish,
      { Sid: 'CalendarificKey', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: arn.secret(RESOURCES.secrets.calendarific) },
      { Sid: 'RosterUploads', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: `${arn.bucket(B.rosters)}/*` },
      { Sid: 'HolidayCache', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: arn.table(RESOURCES.tables.holidayCache) });
  }
  if (service === 'allocation') {
    st.push(
      { Sid: 'ConsumeEvents', Effect: 'Allow', Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'], Resource: arn.queue(RESOURCES.queueName) },
      { Sid: 'SeatMapExports', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: `${arn.bucket(B.seatmaps)}/*` },
      { Sid: 'AllocationMetrics', Effect: 'Allow', Action: 'cloudwatch:PutMetricData', Resource: '*', Condition: { StringEquals: { 'cloudwatch:namespace': `${RESOURCES.metricNamespace}/Allocation` } } });
  }
  return { Version: '2012-10-17', Statement: st };
}

async function provisionIam() {
  console.log('IAM (least-privilege task role per service)');
  const trust = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] });
  for (const s of [...SERVICES, 'gateway']) {
    const RoleName = `esp-${s}-role`;
    await ok(`role ${RoleName}`, () => iam.send(new IAM.CreateRoleCommand({ RoleName, AssumeRolePolicyDocument: trust, Description: `Task role for the ${s} service` })));
    const doc = s === 'gateway'
      ? { Version: '2012-10-17', Statement: [{ Sid: 'OwnLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: arn.logGroup('/esp/gateway') }] }
      : policyFor(s);
    await ok(`policy ${RoleName}`, () => iam.send(new IAM.PutRolePolicyCommand({ RoleName, PolicyName: `esp-${s}-least-privilege`, PolicyDocument: JSON.stringify(doc) })));
  }
}

async function provisionCompute() {
  console.log('VPC + ALB + ECS (control plane, like Lab 8)');
  let vpcId = (await ec2.send(new EC2.DescribeVpcsCommand({ Filters: [{ Name: 'cidr', Values: ['10.20.0.0/16'] }] }))).Vpcs?.[0]?.VpcId;
  if (!vpcId) vpcId = (await ec2.send(new EC2.CreateVpcCommand({ CidrBlock: '10.20.0.0/16' }))).Vpc.VpcId;
  const subnets = [];
  for (const [cidr, az] of [['10.20.1.0/24', 'us-east-1a'], ['10.20.2.0/24', 'us-east-1b']]) {
    let id = (await ec2.send(new EC2.DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpcId] }, { Name: 'cidr-block', Values: [cidr] }] }))).Subnets?.[0]?.SubnetId;
    if (!id) id = (await ec2.send(new EC2.CreateSubnetCommand({ VpcId: vpcId, CidrBlock: cidr, AvailabilityZone: az }))).Subnet.SubnetId;
    subnets.push(id);
  }
  let sg = (await ec2.send(new EC2.DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: ['esp-sg'] }, { Name: 'vpc-id', Values: [vpcId] }] }))).SecurityGroups?.[0]?.GroupId;
  if (!sg) sg = (await ec2.send(new EC2.CreateSecurityGroupCommand({ GroupName: 'esp-sg', Description: 'Exam Seating Planner services', VpcId: vpcId }))).GroupId;
  console.log(`  ✓ VPC ${vpcId}, subnets ${subnets.join(', ')}, SG ${sg}`);

  const albArn = await warn('ALB esp-alb', async () => {
    try { return (await elb.send(new ELB.DescribeLoadBalancersCommand({ Names: ['esp-alb'] }))).LoadBalancers[0].LoadBalancerArn; } catch {
      return (await elb.send(new ELB.CreateLoadBalancerCommand({ Name: 'esp-alb', Subnets: subnets, SecurityGroups: [sg], Type: 'application' }))).LoadBalancers[0].LoadBalancerArn;
    }
  });
  const tgs = {};
  for (const s of SERVICES) {
    tgs[s] = await warn(`target group esp-${s}-tg`, async () => {
      try { return (await elb.send(new ELB.DescribeTargetGroupsCommand({ Names: [`esp-${s}-tg`] }))).TargetGroups[0].TargetGroupArn; } catch {
        return (await elb.send(new ELB.CreateTargetGroupCommand({ Name: `esp-${s}-tg`, Protocol: 'HTTP', Port: PORTS[s], VpcId: vpcId, TargetType: 'ip', HealthCheckPath: '/health' }))).TargetGroups[0].TargetGroupArn;
      }
    });
  }
  if (albArn && tgs.auth) {
    const listeners = (await elb.send(new ELB.DescribeListenersCommand({ LoadBalancerArn: albArn }))).Listeners || [];
    if (listeners.length === 0) {
      const listener = await warn('listener :80', async () => (await elb.send(new ELB.CreateListenerCommand({ LoadBalancerArn: albArn, Protocol: 'HTTP', Port: 80, DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', ContentType: 'application/json', MessageBody: '{"error":{"code":"NOT_FOUND"}}' } }] }))).Listeners[0].ListenerArn);
      const rules = [
        [10, ['/api/auth*'], 'auth'], [20, ['/api/halls*'], 'halls'],
        [30, ['/api/exams/*/allocation*', '/api/exams/*/halls/*/seat-map'], 'allocation'], [40, ['/api/allocations*', '/api/me/*'], 'allocation'],
        [50, ['/api/exams*', '/api/holidays*', '/api/users*'], 'exams'],
      ];
      for (const [Priority, paths, s] of rules) {
        if (listener && tgs[s]) await warn(`ALB rule ${paths.join(',')} -> ${s}`, () => elb.send(new ELB.CreateRuleCommand({ ListenerArn: listener, Priority, Conditions: [{ Field: 'path-pattern', Values: paths }], Actions: [{ Type: 'forward', TargetGroupArn: tgs[s] }] })));
      }
    } else console.log('  = listener + path rules (exist)');
  }

  await ok('ECS cluster esp-cluster', () => ecs.send(new ECS.CreateClusterCommand({ clusterName: 'esp-cluster' })));
  for (const s of SERVICES) {
    const roleArn = `arn:aws:iam::${ACCOUNT_ID}:role/esp-${s}-role`;
    await warn(`task definition esp-${s}`, () => ecs.send(new ECS.RegisterTaskDefinitionCommand({
      family: `esp-${s}`, requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', cpu: '256', memory: '512', taskRoleArn: roleArn, executionRoleArn: roleArn,
      containerDefinitions: [{ name: `esp-${s}`, image: `esp-${s}:local`, portMappings: [{ containerPort: PORTS[s], protocol: 'tcp' }], logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': RESOURCES.logGroup(s), 'awslogs-region': REGION, 'awslogs-stream-prefix': s } } }],
    })));
    const exists = (await ecs.send(new ECS.DescribeServicesCommand({ cluster: 'esp-cluster', services: [`esp-${s}`] }))).services?.some((x) => x.status === 'ACTIVE');
    if (!exists) {
      await warn(`ECS service esp-${s}`, () => ecs.send(new ECS.CreateServiceCommand({ cluster: 'esp-cluster', serviceName: `esp-${s}`, taskDefinition: `esp-${s}`, desiredCount: 1, launchType: 'FARGATE', networkConfiguration: { awsvpcConfiguration: { subnets, securityGroups: [sg], assignPublicIp: 'DISABLED' } }, ...(tgs[s] ? { loadBalancers: [{ targetGroupArn: tgs[s], containerName: `esp-${s}`, containerPort: PORTS[s] }] } : {}) })));
    } else console.log(`  = ECS service esp-${s} (exists)`);
  }
}

(async () => {
  const steps = [provisionS3, provisionDynamo, provisionMessaging, provisionLogs, provisionEventBridge, provisionSecrets, provisionIam, provisionCompute];
  const only = process.argv[2];
  for (const step of steps) {
    if (only && !step.name.toLowerCase().includes(only.toLowerCase())) continue;
    await step();
  }
  console.log('\nDone. Frontend: npm run deploy:web  ->  http://localhost:4566/esp-frontend/index.html');
})().catch((e) => { console.error('\nprovision failed:', e.message); process.exit(1); });
