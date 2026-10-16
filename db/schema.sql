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
  low_level_pct TINYINT UNSIGNED NULL,   -- per-dispenser LOW threshold (%); NULL = server default
  high_temp_c   DECIMAL(4,1) NULL,       -- per-dispenser HIGH_TEMP threshold; NULL = server default
  caretaker_username VARCHAR(50) NULL,   -- who is responsible for this dispenser; NULL = every caretaker is notified
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
  email         VARCHAR(120) NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','caretaker','technician','viewer') NOT NULL DEFAULT 'viewer',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS level_readings (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  dispenser_id  INT NOT NULL,
  level_l       DECIMAL(6,2) NOT NULL,
  temperature_c DECIMAL(4,1) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_disp_time (dispenser_id, created_at),
  FOREIGN KEY (dispenser_id) REFERENCES dispensers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS password_resets (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  username    VARCHAR(50) NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (username),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- Complaints raised by users about a dispenser. Usernames are stored as text so history survives account removal.
CREATE TABLE IF NOT EXISTS complaints (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  dispenser_id    INT NOT NULL,
  reporter        VARCHAR(50) NULL,
  category        ENUM('NO_WATER','LEAK','DIRTY','BROKEN','OTHER') NOT NULL,
  description     VARCHAR(500) NOT NULL,
  status          ENUM('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN',
  technician      VARCHAR(50) NULL,
  resolution_note VARCHAR(500) NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status (status, created_at),
  INDEX idx_reporter (reporter),
  INDEX idx_tech (technician, status),
  FOREIGN KEY (dispenser_id) REFERENCES dispensers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS complaint_events (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  complaint_id INT NOT NULL,
  actor        VARCHAR(50) NULL,
  action       ENUM('CREATED','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED','REOPENED') NOT NULL,
  note         VARCHAR(500) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_complaint (complaint_id, created_at),
  FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE
) ENGINE=InnoDB;
