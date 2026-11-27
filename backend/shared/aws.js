// AWS SDK v3 clients, all pointed at Floci. Created lazily so a service only
// builds the clients it actually uses.
const { AWS } = require('./config');

const cache = {};
function client(name, factory) {
  if (!cache[name]) cache[name] = factory();
  return cache[name];
}

module.exports = {
  s3: () => client('s3', () => new (require('@aws-sdk/client-s3').S3Client)({ ...AWS, forcePathStyle: true })),
  sqs: () => client('sqs', () => new (require('@aws-sdk/client-sqs').SQSClient)(AWS)),
  sns: () => client('sns', () => new (require('@aws-sdk/client-sns').SNSClient)(AWS)),
  events: () => client('events', () => new (require('@aws-sdk/client-eventbridge').EventBridgeClient)(AWS)),
  secrets: () => client('secrets', () => new (require('@aws-sdk/client-secrets-manager').SecretsManagerClient)(AWS)),
  logs: () => client('logs', () => new (require('@aws-sdk/client-cloudwatch-logs').CloudWatchLogsClient)(AWS)),
  cloudwatch: () => client('cloudwatch', () => new (require('@aws-sdk/client-cloudwatch').CloudWatchClient)(AWS)),
  dynamo: () => client('dynamo', () => {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    return DynamoDBDocumentClient.from(new DynamoDBClient(AWS), { marshallOptions: { removeUndefinedValues: true } });
  }),
};
