# IAM role for Lambda execution
resource "aws_iam_role" "lambda_rate_limiter" {
  name        = "rate-limiter-lambda-${var.environment}"
  description = "Execution role for Lambda functions using the rate limiter module"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })

  tags = {
    Name = "rate-limiter-lambda-${var.environment}"
  }
}

# Basic Lambda execution policy — includes VPC ENI permissions for ElastiCache access
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_rate_limiter.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# CloudWatch metrics policy — scoped to RateLimiter namespace
resource "aws_iam_role_policy" "cloudwatch_metrics" {
  name = "rate-limiter-cloudwatch-${var.environment}"
  role = aws_iam_role.lambda_rate_limiter.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cloudwatch:PutMetricData",
      ]
      Resource = "*"
      Condition = {
        StringEquals = {
          "cloudwatch:namespace" = "RateLimiter"
        }
      }
    }]
  })
}

# SSM Parameter Store policy — scoped to rate-limiter config path
resource "aws_iam_role_policy" "ssm_config" {
  name = "rate-limiter-ssm-${var.environment}"
  role = aws_iam_role.lambda_rate_limiter.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
      ]
      Resource = "arn:aws:ssm:${var.aws_region}:*:parameter${var.ssm_parameter_path}/*"
    }]
  })
}

# ElastiCache describe policy — needed to resolve cluster endpoints at startup
resource "aws_iam_role_policy" "elasticache_describe" {
  name = "rate-limiter-elasticache-describe-${var.environment}"
  role = aws_iam_role.lambda_rate_limiter.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "elasticache:DescribeReplicationGroups",
        "elasticache:DescribeCacheClusters",
      ]
      Resource = aws_elasticache_replication_group.rate_limiter.arn
    }]
  })
}
