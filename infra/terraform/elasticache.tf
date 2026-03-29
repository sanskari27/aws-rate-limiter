resource "aws_elasticache_subnet_group" "rate_limiter" {
  name        = "rate-limiter-${var.environment}"
  description = "Subnet group for rate limiter ElastiCache cluster"
  subnet_ids  = var.private_subnet_ids
}

resource "aws_security_group" "elasticache" {
  name        = "rate-limiter-elasticache-${var.environment}"
  description = "Security group for rate limiter ElastiCache — allows inbound Redis TLS from app only"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 6380
    to_port         = 6380
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
    description     = "Redis TLS from application"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }

  tags = {
    Name = "rate-limiter-elasticache-${var.environment}"
  }
}

resource "aws_elasticache_parameter_group" "rate_limiter" {
  family      = "redis7"
  name        = "rate-limiter-${var.environment}"
  description = "Rate limiter Redis parameter group — allkeys-lru eviction for TTL-bearing keys"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  parameter {
    name  = "activerehashing"
    value = "yes"
  }

  parameter {
    name  = "tcp-keepalive"
    value = "60"
  }
}

resource "aws_elasticache_replication_group" "rate_limiter" {
  replication_group_id = "rate-limiter-${var.environment}"
  description          = "Rate limiter Redis cluster — sliding window counters with 1M req/s throughput"

  node_type               = var.elasticache_node_type
  num_node_groups         = var.elasticache_num_shards
  replicas_per_node_group = var.elasticache_replicas_per_shard

  # Redis 7.x cluster mode
  engine         = "redis"
  engine_version = "7.1"
  port           = 6380

  # Security — TLS in-transit and at-rest encryption with auth token
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token

  # Availability — Multi-AZ with automatic failover
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.rate_limiter.name
  security_group_ids         = [aws_security_group.elasticache.id]

  parameter_group_name = aws_elasticache_parameter_group.rate_limiter.name

  # Maintenance window — low-traffic Sunday early morning UTC
  maintenance_window       = "sun:05:00-sun:06:00"
  snapshot_retention_limit = 1
  snapshot_window          = "03:00-04:00"

  # Apply immediately in non-production to speed up iteration
  apply_immediately = var.environment != "production"

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.elasticache_slow_log.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = {
    Name = "rate-limiter-${var.environment}"
  }
}

resource "aws_cloudwatch_log_group" "elasticache_slow_log" {
  name              = "/aws/elasticache/rate-limiter-${var.environment}/slow-log"
  retention_in_days = 7

  tags = {
    Name = "rate-limiter-elasticache-slow-log-${var.environment}"
  }
}
