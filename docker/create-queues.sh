#!/bin/sh
set -e

# roda dentro do container do localstack (ready.d)
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# o consumer manda pra DLQ sozinho depois de SQS_MAX_ATTEMPTS (5).
# a redrive policy fica um pouco acima disso só como rede de segurança.
cat > /tmp/main-queue.json <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"8\"}"
}
JSON
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes file:///tmp/main-queue.json

awslocal sqs create-queue --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "queues ready"
