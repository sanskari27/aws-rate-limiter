variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region to deploy resources into"
}

variable "environment" {
  type        = string
  default     = "production"
  description = "Deployment environment (dev, staging, or production)"

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be one of: dev, staging, production."
  }
}

variable "vpc_id" {
  type        = string
  description = "VPC ID for ElastiCache subnet group"
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs across 3 AZs for the ElastiCache subnet group"
}

variable "app_security_group_id" {
  type        = string
  description = "Security group ID of the application (Lambda/ECS) that connects to Redis"
}

variable "elasticache_node_type" {
  type        = string
  default     = "cache.r7g.large"
  description = "ElastiCache node instance type"
}

variable "elasticache_num_shards" {
  type        = number
  default     = 6
  description = "Number of shards (primary nodes) in the ElastiCache cluster"
}

variable "elasticache_replicas_per_shard" {
  type        = number
  default     = 2
  description = "Number of read replicas per shard for high availability"
}

variable "redis_auth_token" {
  type        = string
  sensitive   = true
  description = "Auth token for Redis (in-transit and at-rest authentication)"
}

variable "sns_alarm_topic_arn" {
  type        = string
  default     = ""
  description = "SNS topic ARN for CloudWatch alarm notifications (leave empty to disable notifications)"
}

variable "ssm_parameter_path" {
  type        = string
  default     = "/rate-limiter"
  description = "SSM Parameter Store path prefix for rate limiter configuration"
}
