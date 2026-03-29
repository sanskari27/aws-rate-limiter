output "elasticache_configuration_endpoint" {
  description = "ElastiCache cluster configuration endpoint (TLS, rediss:// scheme)"
  value       = "rediss://${aws_elasticache_replication_group.rate_limiter.configuration_endpoint_address}:6380"
}

output "elasticache_replication_group_id" {
  description = "ElastiCache replication group ID"
  value       = aws_elasticache_replication_group.rate_limiter.id
}

output "elasticache_replication_group_arn" {
  description = "ElastiCache replication group ARN"
  value       = aws_elasticache_replication_group.rate_limiter.arn
}

output "elasticache_security_group_id" {
  description = "Security group ID for ElastiCache — attach to Lambda/ECS to allow Redis access"
  value       = aws_security_group.elasticache.id
}

output "elasticache_num_shards" {
  description = "Number of shards (primary nodes) in the cluster"
  value       = aws_elasticache_replication_group.rate_limiter.num_node_groups
}

output "lambda_execution_role_arn" {
  description = "IAM role ARN for Lambda execution — use as the Lambda function's role"
  value       = aws_iam_role.lambda_rate_limiter.arn
}

output "lambda_execution_role_name" {
  description = "IAM role name for Lambda execution"
  value       = aws_iam_role.lambda_rate_limiter.name
}

output "redis_connection_url_ssm_suggestion" {
  description = "Suggested SSM parameter path for storing the Redis connection URL"
  value       = "${var.ssm_parameter_path}/${var.environment}/redis-url"
}

output "cloudwatch_dashboard_url" {
  description = "URL to the CloudWatch dashboard for this deployment"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=RateLimiter-${var.environment}"
}

output "elasticache_slow_log_group" {
  description = "CloudWatch log group name for ElastiCache slow logs"
  value       = aws_cloudwatch_log_group.elasticache_slow_log.name
}
