CREATE DATABASE IF NOT EXISTS smart_water;
USE smart_water;

CREATE TABLE IF NOT EXISTS dispensers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(80)  NOT NULL,
  location      VARCHAR(120) NOT NULL,
  capacity_l    DECIMAL(6,2) NOT NULL DEFAULT 20.00,
  level_l       DECIMAL(6,2) NOT NULL DEFAULT 0.00,
  temperature_c DECIMAL(4,1) NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  last_seen     DATETIME     NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_level CHECK (level_l >= 0 AND level_l <= capacity_l)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS dispense_events (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  dispenser_id  INT NOT NULL,
  volume_ml     INT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_disp_time (dispenser_id, created_at),
  INDEX idx_time (created_at),
  FOREIGN KEY (dispenser_id) REFERENCES dispensers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS refills (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  dispenser_id  INT NOT NULL,
  added_l       DECIMAL(6,2) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (dispenser_id) REFERENCES dispensers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS alerts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  dispenser_id  INT NOT NULL,
  type          ENUM('LOW_LEVEL','EMPTY','OFFLINE','HIGH_TEMP') NOT NULL,
  message       VARCHAR(255) NOT NULL,
  resolved      TINYINT(1) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at   TIMESTAMP NULL,
  INDEX idx_open (resolved, dispenser_id, type),
  FOREIGN KEY (dispenser_id) REFERENCES dispensers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','viewer') NOT NULL DEFAULT 'viewer',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
