# ── Application-level alarms (RateLimiter namespace) ─────────────────────────

resource "aws_cloudwatch_metric_alarm" "high_denial_rate" {
  alarm_name          = "RateLimiter-HighDenialRate-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "rate_limiter.check.denied"
  namespace           = "RateLimiter"
  period              = 60
  statistic           = "Sum"
  threshold           = 1000
  alarm_description   = "Rate limiter denial rate above 1000/min for 3 consecutive periods — possible DDoS or misconfiguration"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  dimensions = {
    Environment = var.environment
  }

  tags = {
    Name = "RateLimiter-HighDenialRate-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_fail_open" {
  alarm_name          = "RateLimiter-RedisFailOpen-${var.environment}"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "rate_limiter.fail_open"
  namespace           = "RateLimiter"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Rate limiter failing open — Redis unreachable, all requests being allowed through"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  tags = {
    Name = "RateLimiter-RedisFailOpen-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_memory_high" {
  alarm_name          = "RateLimiter-RedisMemoryHigh-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "rate_limiter.redis.memory_utilization"
  namespace           = "RateLimiter"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0.85
  alarm_description   = "ElastiCache memory utilization above 85% — eviction pressure may cause incorrect rate limit counts"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  tags = {
    Name = "RateLimiter-RedisMemoryHigh-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "high_latency" {
  alarm_name          = "RateLimiter-HighLatency-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "rate_limiter.check.latency"
  namespace           = "RateLimiter"
  period              = 60
  extended_statistic  = "p99"
  threshold           = 10
  alarm_description   = "Rate limiter p99 latency above 10ms for 5 consecutive periods — investigate Redis cluster health"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  tags = {
    Name = "RateLimiter-HighLatency-${var.environment}"
  }
}

# ── ElastiCache native alarms (AWS/ElastiCache namespace) ─────────────────────

resource "aws_cloudwatch_metric_alarm" "elasticache_cpu" {
  alarm_name          = "RateLimiter-ElasticacheCPU-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "EngineCPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 70
  alarm_description   = "ElastiCache engine CPU above 70% — may impact Lua script execution latency"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.rate_limiter.id
  }

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  tags = {
    Name = "RateLimiter-ElasticacheCPU-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "elasticache_memory_native" {
  alarm_name          = "RateLimiter-ElasticacheMemory-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Maximum"
  threshold           = 85
  alarm_description   = "ElastiCache native memory usage above 85% — key eviction may corrupt sliding window counters"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.rate_limiter.id
  }

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  tags = {
    Name = "RateLimiter-ElasticacheMemory-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "elasticache_replication_lag" {
  alarm_name          = "RateLimiter-ElasticacheReplicationLag-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ReplicationLag"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "ElastiCache replication lag above 1 second — replica reads may be stale"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.rate_limiter.id
  }

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  tags = {
    Name = "RateLimiter-ElasticacheReplicationLag-${var.environment}"
  }
}

# ── CloudWatch Dashboard ──────────────────────────────────────────────────────

resource "aws_cloudwatch_dashboard" "rate_limiter" {
  dashboard_name = "RateLimiter-${var.environment}"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Request Allow / Deny Rate"
          period = 60
          stat   = "Sum"
          metrics = [
            ["RateLimiter", "rate_limiter.check.allowed", "Environment", var.environment],
            ["RateLimiter", "rate_limiter.check.denied", "Environment", var.environment],
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Check Latency (p50 / p99)"
          period = 60
          metrics = [
            [{ expression = "SELECT PERCENTILE(rate_limiter.check.latency, 50) FROM SCHEMA(RateLimiter, Environment) WHERE Environment = '${var.environment}'", label = "p50", id = "p50" }],
            [{ expression = "SELECT PERCENTILE(rate_limiter.check.latency, 99) FROM SCHEMA(RateLimiter, Environment) WHERE Environment = '${var.environment}'", label = "p99", id = "p99" }],
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Reservoir Hit Rate"
          period = 60
          stat   = "Sum"
          metrics = [
            ["RateLimiter", "rate_limiter.reservoir.hit", "Environment", var.environment],
            ["RateLimiter", "rate_limiter.reservoir.miss", "Environment", var.environment],
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Circuit Breaker Events"
          period = 60
          stat   = "Sum"
          metrics = [
            ["RateLimiter", "rate_limiter.fail_open", "Environment", var.environment],
            ["RateLimiter", "rate_limiter.fail_closed", "Environment", var.environment],
            ["RateLimiter", "rate_limiter.fail_local", "Environment", var.environment],
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "ElastiCache CPU"
          period = 60
          stat   = "Average"
          metrics = [
            ["AWS/ElastiCache", "EngineCPUUtilization", "ReplicationGroupId", "rate-limiter-${var.environment}"],
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "ElastiCache Memory"
          period = 300
          stat   = "Maximum"
          metrics = [
            ["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "ReplicationGroupId", "rate-limiter-${var.environment}"],
          ]
          view = "timeSeries"
        }
      },
    ]
  })
}
