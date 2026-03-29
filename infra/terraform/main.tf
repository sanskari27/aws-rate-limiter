terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    # Configure via -backend-config or workspace
    # bucket = "your-terraform-state-bucket"
    # key    = "rate-limiter/terraform.tfstate"
    # region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "aws-rate-limiter"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
