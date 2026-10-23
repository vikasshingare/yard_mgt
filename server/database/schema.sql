-- ICD Yard Management System database
-- Apply with: mysql -u root -p < server/database/schema.sql
CREATE DATABASE IF NOT EXISTS icd_yms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE icd_yms;

CREATE TABLE IF NOT EXISTS yard_locations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  depot_code VARCHAR(30) NOT NULL DEFAULT 'CHN-ICD',
  block_code VARCHAR(10) NOT NULL,
  row_code VARCHAR(10) NOT NULL,
  bay_code VARCHAR(10) NOT NULL,
  tier TINYINT UNSIGNED NOT NULL DEFAULT 1,
  position_code VARCHAR(10) NOT NULL DEFAULT '01',
  location_code VARCHAR(40) NOT NULL UNIQUE,
  length_m DECIMAL(8,2) NULL, width_m DECIMAL(8,2) NULL, height_m DECIMAL(8,2) NULL,
  capacity_kg DECIMAL(10,2) NULL, max_stack_tier TINYINT UNSIGNED NULL,
  availability_status ENUM('AVAILABLE','BLOCKED','MAINTENANCE','RETIRED') NOT NULL DEFAULT 'AVAILABLE',
  storage_zone VARCHAR(40) NULL, handling_access VARCHAR(40) NULL, operational_group VARCHAR(40) NULL,
  gate_distance_m DECIMAL(8,2) NULL, reservation_expires_at DATETIME NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_reason VARCHAR(255),
  allowed_types JSON NULL,
  max_weight_kg DECIMAL(10,2) NULL,
  occupied_container_id BIGINT UNSIGNED NULL,
  reserved_task_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_slot_position (depot_code,block_code,row_code,bay_code,tier,position_code),
  KEY idx_location_status (is_active,is_blocked,block_code)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS containers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  container_number VARCHAR(20) NOT NULL UNIQUE,
  iso_size VARCHAR(8) NOT NULL,
  direction ENUM('INBOUND','OUTBOUND','IMPORT','EXPORT','TRANSHIPMENT','DOMESTIC') NOT NULL DEFAULT 'INBOUND',
  customer VARCHAR(160),
  shipping_line VARCHAR(100),
  status ENUM('EXPECTED','GATE_IN','IN_YARD','READY_OUT','GATED_OUT','ON_HOLD','EXCEPTION') NOT NULL DEFAULT 'EXPECTED',
  hold_status ENUM('CLEAR','CUSTOMS','COMMERCIAL','SECURITY','INSPECTION','DOCUMENTATION','DAMAGE') NOT NULL DEFAULT 'CLEAR',
  hold_reason VARCHAR(255),
  seal_number VARCHAR(80),
  weight_kg DECIMAL(10,2),
  manifest_ref VARCHAR(100),
  current_location_id BIGINT UNSIGNED NULL,
  yard_in_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_container_search (container_number,status,hold_status),
  KEY idx_container_dwell (yard_in_at,status),
  CONSTRAINT fk_container_location FOREIGN KEY (current_location_id) REFERENCES yard_locations(id) ON DELETE SET NULL
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS movement_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  container_id BIGINT UNSIGNED NOT NULL,
  task_type ENUM('PUTAWAY','RETRIEVAL','RELOCATION','REHANDLE','YARD_CORRECTION') NOT NULL,
  priority ENUM('URGENT','HIGH','NORMAL','LOW') NOT NULL DEFAULT 'NORMAL',
  status ENUM('QUEUED','ASSIGNED','IN_PROGRESS','PICKUP_CONFIRMED','COMPLETED','EXCEPTION','BLOCKED','FAILED','AWAITING_APPROVAL','CANCELLED') NOT NULL DEFAULT 'QUEUED',
  source_location_id BIGINT UNSIGNED NULL,
  destination_location_id BIGINT UNSIGNED NULL,
  actual_destination_location_id BIGINT UNSIGNED NULL,
  assigned_operator VARCHAR(120),
  assigned_equipment VARCHAR(80),
  reason VARCHAR(255),
  exception_reason VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  picked_up_at DATETIME NULL,
  pickup_confirmed_by VARCHAR(254) NULL,
  allocation_override_reason VARCHAR(500) NULL,
  allocation_override_approved_by VARCHAR(254) NULL,
  completed_at DATETIME NULL,
  CONSTRAINT fk_task_container FOREIGN KEY (container_id) REFERENCES containers(id),
  CONSTRAINT fk_task_source FOREIGN KEY (source_location_id) REFERENCES yard_locations(id) ON DELETE SET NULL,
  CONSTRAINT fk_task_destination FOREIGN KEY (destination_location_id) REFERENCES yard_locations(id) ON DELETE SET NULL,
  CONSTRAINT fk_task_actual FOREIGN KEY (actual_destination_location_id) REFERENCES yard_locations(id) ON DELETE SET NULL,
  KEY idx_task_queue (status,priority,created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS movement_task_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, task_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(40) NOT NULL, actor VARCHAR(254) NOT NULL, detail VARCHAR(500),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_task_event_task FOREIGN KEY(task_id) REFERENCES movement_tasks(id),
  KEY idx_task_event(task_id,created_at)
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS visits (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  container_id BIGINT UNSIGNED NOT NULL,
  direction ENUM('IN','OUT') NOT NULL,
  truck_registration VARCHAR(30) NOT NULL,
  driver_name VARCHAR(120),
  carrier VARCHAR(120),
  manifest_ref VARCHAR(100),
  seal_number VARCHAR(80),
  gate_in_at DATETIME NULL,
  gate_out_at DATETIME NULL,
  gate_out_reference VARCHAR(100) NULL,
  handover_evidence VARCHAR(500) NULL,
  receipt_reference VARCHAR(100) NULL,
  status ENUM('OPEN','CLOSED','EXCEPTION') NOT NULL DEFAULT 'OPEN',
  exception_reason VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_visit_container FOREIGN KEY (container_id) REFERENCES containers(id),
  KEY idx_visit_open (container_id,status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS movement_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  container_id BIGINT UNSIGNED NULL,
  container_number VARCHAR(20) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  location_code VARCHAR(40),
  actor VARCHAR(120) NOT NULL DEFAULT 'System',
  reason VARCHAR(255),
  previous_values JSON NULL,
  new_values JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_event_container FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE SET NULL,
  KEY idx_event_history (container_number,created_at),
  KEY idx_event_date (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS inspections (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  container_id BIGINT UNSIGNED NOT NULL,
  visit_id BIGINT UNSIGNED NULL,
  inspection_type VARCHAR(40) NOT NULL DEFAULT 'ARRIVAL',
  result ENUM('PASS','DAMAGE','HOLD','REVIEW') NOT NULL,
  condition_notes TEXT,
  damage_category VARCHAR(80) NULL,
  evidence_refs JSON NULL,
  follow_up VARCHAR(500) NULL,
  seal_condition VARCHAR(120),
  hold_type VARCHAR(40),
  hold_reason VARCHAR(255),
  release_authority VARCHAR(120),
  inspected_by VARCHAR(120) NOT NULL DEFAULT 'System',
  inspected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at DATETIME NULL,
  CONSTRAINT fk_inspection_container FOREIGN KEY (container_id) REFERENCES containers(id),
  KEY idx_inspection_hold (result,hold_type)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor VARCHAR(120) NOT NULL,
  role_name VARCHAR(80) NOT NULL DEFAULT 'System',
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id VARCHAR(80),
  reason VARCHAR(255),
  old_values JSON NULL,
  new_values JSON NULL,
  correlation_id VARCHAR(80),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_entity (entity_type,entity_id,created_at),
  KEY idx_audit_actor (actor,created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS vision_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  location_id BIGINT UNSIGNED NULL,
  camera_code VARCHAR(80),
  image_reference VARCHAR(500),
  candidate_container_number VARCHAR(20),
  confidence DECIMAL(5,4),
  detected_tier TINYINT UNSIGNED,
  detected_occupancy BOOLEAN,
  review_status ENUM('PENDING','ACCEPTED','CORRECTED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reviewed_by VARCHAR(120),
  reviewed_at DATETIME NULL,
  final_container_number VARCHAR(20),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_vision_location FOREIGN KEY (location_id) REFERENCES yard_locations(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Demo yard: four blocks, ten bays each, three tiers per bay (120 slots).
INSERT IGNORE INTO yard_locations (block_code,row_code,bay_code,tier,location_code,is_blocked,blocked_reason) VALUES
('A','01','01',1,'A-01-01-1',0,NULL),('A','01','01',2,'A-01-01-2',0,NULL),('A','01','01',3,'A-01-01-3',0,NULL),
('A','01','02',1,'A-01-02-1',0,NULL),('A','01','02',2,'A-01-02-2',0,NULL),('A','01','02',3,'A-01-02-3',0,NULL),
('A','01','03',1,'A-01-03-1',0,NULL),('A','01','03',2,'A-01-03-2',0,NULL),('A','01','03',3,'A-01-03-3',0,NULL),
('A','01','04',1,'A-01-04-1',0,NULL),('A','01','04',2,'A-01-04-2',0,NULL),('A','01','04',3,'A-01-04-3',0,NULL),
('A','01','05',1,'A-01-05-1',0,NULL),('A','01','05',2,'A-01-05-2',0,NULL),('A','01','05',3,'A-01-05-3',0,NULL),
('A','01','06',1,'A-01-06-1',0,NULL),('A','01','06',2,'A-01-06-2',0,NULL),('A','01','06',3,'A-01-06-3',0,NULL),
('A','01','07',1,'A-01-07-1',0,NULL),('A','01','07',2,'A-01-07-2',0,NULL),('A','01','07',3,'A-01-07-3',0,NULL),
('A','01','08',1,'A-01-08-1',0,NULL),('A','01','08',2,'A-01-08-2',0,NULL),('A','01','08',3,'A-01-08-3',0,NULL),
('A','01','09',1,'A-01-09-1',1,'Safety inspection'),('A','01','09',2,'A-01-09-2',1,'Safety inspection'),('A','01','09',3,'A-01-09-3',1,'Safety inspection'),
('A','01','10',1,'A-01-10-1',0,NULL),('A','01','10',2,'A-01-10-2',0,NULL),('A','01','10',3,'A-01-10-3',0,NULL),
('B','01','01',1,'B-01-01-1',0,NULL),('B','01','01',2,'B-01-01-2',0,NULL),('B','01','01',3,'B-01-01-3',0,NULL),
('B','01','02',1,'B-01-02-1',0,NULL),('B','01','02',2,'B-01-02-2',0,NULL),('B','01','02',3,'B-01-02-3',0,NULL),
('B','01','03',1,'B-01-03-1',0,NULL),('B','01','03',2,'B-01-03-2',0,NULL),('B','01','03',3,'B-01-03-3',0,NULL),
('B','01','04',1,'B-01-04-1',0,NULL),('B','01','04',2,'B-01-04-2',0,NULL),('B','01','04',3,'B-01-04-3',0,NULL),
('B','01','05',1,'B-01-05-1',0,NULL),('B','01','05',2,'B-01-05-2',0,NULL),('B','01','05',3,'B-01-05-3',0,NULL),
('B','01','06',1,'B-01-06-1',0,NULL),('B','01','06',2,'B-01-06-2',0,NULL),('B','01','06',3,'B-01-06-3',0,NULL),
('B','01','07',1,'B-01-07-1',0,NULL),('B','01','07',2,'B-01-07-2',0,NULL),('B','01','07',3,'B-01-07-3',0,NULL),
('B','01','08',1,'B-01-08-1',0,NULL),('B','01','08',2,'B-01-08-2',0,NULL),('B','01','08',3,'B-01-08-3',0,NULL),
('B','01','09',1,'B-01-09-1',0,NULL),('B','01','09',2,'B-01-09-2',0,NULL),('B','01','09',3,'B-01-09-3',0,NULL),
('B','01','10',1,'B-01-10-1',0,NULL),('B','01','10',2,'B-01-10-2',0,NULL),('B','01','10',3,'B-01-10-3',0,NULL),
('C','01','01',1,'C-01-01-1',0,NULL),('C','01','01',2,'C-01-01-2',0,NULL),('C','01','01',3,'C-01-01-3',0,NULL),
('C','01','02',1,'C-01-02-1',0,NULL),('C','01','02',2,'C-01-02-2',0,NULL),('C','01','02',3,'C-01-02-3',0,NULL),
('C','01','03',1,'C-01-03-1',0,NULL),('C','01','03',2,'C-01-03-2',0,NULL),('C','01','03',3,'C-01-03-3',0,NULL),
('C','01','04',1,'C-01-04-1',0,NULL),('C','01','04',2,'C-01-04-2',0,NULL),('C','01','04',3,'C-01-04-3',0,NULL),
('C','01','05',1,'C-01-05-1',0,NULL),('C','01','05',2,'C-01-05-2',0,NULL),('C','01','05',3,'C-01-05-3',0,NULL),
('C','01','06',1,'C-01-06-1',0,NULL),('C','01','06',2,'C-01-06-2',0,NULL),('C','01','06',3,'C-01-06-3',0,NULL),
('C','01','07',1,'C-01-07-1',0,NULL),('C','01','07',2,'C-01-07-2',0,NULL),('C','01','07',3,'C-01-07-3',0,NULL),
('C','01','08',1,'C-01-08-1',0,NULL),('C','01','08',2,'C-01-08-2',0,NULL),('C','01','08',3,'C-01-08-3',0,NULL),
('C','01','09',1,'C-01-09-1',0,NULL),('C','01','09',2,'C-01-09-2',0,NULL),('C','01','09',3,'C-01-09-3',0,NULL),
('C','01','10',1,'C-01-10-1',0,NULL),('C','01','10',2,'C-01-10-2',0,NULL),('C','01','10',3,'C-01-10-3',0,NULL),
('D','01','01',1,'D-01-01-1',0,NULL),('D','01','01',2,'D-01-01-2',0,NULL),('D','01','01',3,'D-01-01-3',0,NULL),
('D','01','02',1,'D-01-02-1',0,NULL),('D','01','02',2,'D-01-02-2',0,NULL),('D','01','02',3,'D-01-02-3',0,NULL),
('D','01','03',1,'D-01-03-1',0,NULL),('D','01','03',2,'D-01-03-2',0,NULL),('D','01','03',3,'D-01-03-3',0,NULL),
('D','01','04',1,'D-01-04-1',0,NULL),('D','01','04',2,'D-01-04-2',0,NULL),('D','01','04',3,'D-01-04-3',0,NULL),
('D','01','05',1,'D-01-05-1',0,NULL),('D','01','05',2,'D-01-05-2',0,NULL),('D','01','05',3,'D-01-05-3',0,NULL),
('D','01','06',1,'D-01-06-1',0,NULL),('D','01','06',2,'D-01-06-2',0,NULL),('D','01','06',3,'D-01-06-3',0,NULL),
('D','01','07',1,'D-01-07-1',0,NULL),('D','01','07',2,'D-01-07-2',0,NULL),('D','01','07',3,'D-01-07-3',0,NULL),
('D','01','08',1,'D-01-08-1',0,NULL),('D','01','08',2,'D-01-08-2',0,NULL),('D','01','08',3,'D-01-08-3',0,NULL),
('D','01','09',1,'D-01-09-1',0,NULL),('D','01','09',2,'D-01-09-2',0,NULL),('D','01','09',3,'D-01-09-3',0,NULL),
('D','01','10',1,'D-01-10-1',0,NULL),('D','01','10',2,'D-01-10-2',0,NULL),('D','01','10',3,'D-01-10-3',0,NULL);

INSERT IGNORE INTO containers (container_number,iso_size,direction,customer,shipping_line,status,hold_status,manifest_ref,yard_in_at) VALUES
('MSCU 482193 0','40HC','IMPORT','Maersk Logistics','MAERSK','IN_YARD','CLEAR','MNF-24018',NOW()-INTERVAL 31 HOUR),
('TGHU 731904 2','20GP','IMPORT','BlueWave Exports','CMA CGM','IN_YARD','CUSTOMS','MNF-24022',NOW()-INTERVAL 76 HOUR),
('CMAU 119827 6','40HC','EXPORT','Eastern Trade Co.','CMA CGM','IN_YARD','CLEAR','BK-882103',NOW()-INTERVAL 18 HOUR),
('OOLU 660318 4','20GP','IMPORT','Harbor Freight Ltd.','OOCL','GATE_IN','CLEAR','MNF-24029',NOW()-INTERVAL 2 HOUR),
('FSCU 208451 1','40HC','IMPORT','TransAsia Cargo','HAPAG-LLOYD','IN_YARD','CLEAR','MNF-24012',NOW()-INTERVAL 122 HOUR);

UPDATE containers c JOIN yard_locations l ON l.location_code='A-01-04-1' SET c.current_location_id=l.id WHERE c.container_number='MSCU 482193 0';
UPDATE containers c JOIN yard_locations l ON l.location_code='A-01-02-1' SET c.current_location_id=l.id WHERE c.container_number='TGHU 731904 2';
UPDATE containers c JOIN yard_locations l ON l.location_code='B-01-03-1' SET c.current_location_id=l.id WHERE c.container_number='CMAU 119827 6';
UPDATE containers c JOIN yard_locations l ON l.location_code='C-01-01-1' SET c.current_location_id=l.id WHERE c.container_number='FSCU 208451 1';
UPDATE yard_locations l JOIN containers c ON c.current_location_id=l.id SET l.occupied_container_id=c.id;

INSERT INTO movement_tasks (container_id,task_type,priority,status,source_location_id,destination_location_id,reason)
SELECT c.id,'PUTAWAY','HIGH','QUEUED',NULL,l.id,'Inbound putaway' FROM containers c JOIN yard_locations l ON l.location_code='A-01-05-1' WHERE c.container_number='OOLU 660318 4' AND NOT EXISTS (SELECT 1 FROM movement_tasks WHERE container_id=c.id AND status IN ('QUEUED','ASSIGNED','IN_PROGRESS'));
INSERT INTO movement_tasks (container_id,task_type,priority,status,source_location_id,destination_location_id,reason)
SELECT c.id,'RETRIEVAL','NORMAL','IN_PROGRESS',l.id,NULL,'Outbound release' FROM containers c JOIN yard_locations l ON l.location_code='A-01-04-1' WHERE c.container_number='MSCU 482193 0' AND NOT EXISTS (SELECT 1 FROM movement_tasks WHERE container_id=c.id AND status IN ('QUEUED','ASSIGNED','IN_PROGRESS'));
UPDATE yard_locations l JOIN movement_tasks t ON t.destination_location_id=l.id AND t.status IN ('QUEUED','ASSIGNED','IN_PROGRESS') SET l.reserved_task_id=t.id;

INSERT INTO visits (container_id,direction,truck_registration,driver_name,manifest_ref,gate_in_at,status)
SELECT c.id,'IN','TN 09 AB 4832','R. Kumar',c.manifest_ref,NOW()-INTERVAL 2 HOUR,'OPEN' FROM containers c WHERE c.container_number='OOLU 660318 4' AND NOT EXISTS (SELECT 1 FROM visits WHERE container_id=c.id AND status='OPEN');

INSERT INTO movement_events (container_id,container_number,event_type,location_code,actor,reason)
SELECT c.id,c.container_number,'GATE_IN','Gate lane 01','Gate Operator','Inbound arrival' FROM containers c WHERE c.container_number='TGHU 731904 2' AND NOT EXISTS (SELECT 1 FROM movement_events WHERE container_id=c.id AND event_type='GATE_IN');
INSERT INTO movement_events (container_id,container_number,event_type,location_code,actor,reason)
SELECT c.id,c.container_number,'PUTAWAY',l.location_code,'Yard Operator','Container placed in yard' FROM containers c JOIN yard_locations l ON c.current_location_id=l.id WHERE c.container_number='MSCU 482193 0' AND NOT EXISTS (SELECT 1 FROM movement_events WHERE container_id=c.id AND event_type='PUTAWAY');
INSERT INTO movement_events (container_id,container_number,event_type,location_code,actor,reason)
SELECT c.id,c.container_number,'RELOCATION',l.location_code,'Yard Operator','Planned relocation' FROM containers c JOIN yard_locations l ON c.current_location_id=l.id WHERE c.container_number='CMAU 119827 6' AND NOT EXISTS (SELECT 1 FROM movement_events WHERE container_id=c.id AND event_type='RELOCATION');

INSERT INTO inspections (container_id,inspection_type,result,condition_notes,hold_type,hold_reason,inspected_by)
SELECT c.id,'ARRIVAL','HOLD','Customs documentation awaiting clearance','CUSTOMS','Awaiting customs release','Inspection Team' FROM containers c WHERE c.container_number='TGHU 731904 2' AND NOT EXISTS (SELECT 1 FROM inspections WHERE container_id=c.id);

INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason)
SELECT 'System','System Administrator','SEED','DATABASE','icd_yms','Initial demonstration setup' WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action='SEED' AND entity_id='icd_yms');

-- Authentication, role-based access and token lifecycle
CREATE TABLE IF NOT EXISTS roles (
  role_name VARCHAR(80) PRIMARY KEY,
  description VARCHAR(255) NOT NULL DEFAULT '',
  is_system BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS permissions (
  permission_code VARCHAR(80) PRIMARY KEY,
  description VARCHAR(255) NOT NULL DEFAULT ''
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_name VARCHAR(80) NOT NULL,
  permission_code VARCHAR(80) NOT NULL,
  PRIMARY KEY (role_name, permission_code),
  CONSTRAINT fk_role_permission_role FOREIGN KEY (role_name) REFERENCES roles(role_name) ON DELETE CASCADE,
  CONSTRAINT fk_role_permission_permission FOREIGN KEY (permission_code) REFERENCES permissions(permission_code) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_name VARCHAR(80) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_role FOREIGN KEY (role_name) REFERENCES roles(role_name),
  KEY idx_user_status (is_active,role_name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  refresh_token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  replaced_by_session_id CHAR(36) NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_session_user (user_id,expires_at),
  KEY idx_session_expiry (expires_at,revoked_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  requested_ip VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_reset_expiry (user_id,expires_at,used_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS login_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  email_attempted VARCHAR(254) NOT NULL,
  succeeded BOOLEAN NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  failure_reason VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_login_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  KEY idx_login_email (email_attempted,created_at),
  KEY idx_login_user (user_id,created_at)
) ENGINE=InnoDB;

INSERT IGNORE INTO roles (role_name,description) VALUES
('System Administrator','Manage users, permissions, configuration, integrations and system health.'),
('ICD Operations Manager','Review operations, approve configured exceptions and manage operating rules.'),
('Gate Operator','Create and manage gate transactions, driver details and gate exceptions.'),
('Yard Planner / Yard Controller','Manage inventory, slots, movement planning, dispatch and reconciliation.'),
('Reach-Stacker Operator','View assigned work and confirm or report moves.'),
('Inspection / Security','Record inspections, evidence, holds and authorised observations.'),
('Billing / Finance','Review dwell time, handling events and billing support.'),
('Auditor / Management','Read-only access to approved operational and audit data.'),
('External Partner','Restricted access to approved partner information.');

INSERT IGNORE INTO permissions (permission_code,description) VALUES
('dashboard:read','View operational dashboard'),('containers:read','Read container inventory'),('containers:write','Create or update inventory'),
('yard:read','View yard locations'),('yard:plan','Plan slot allocation'),('tasks:read','View movement tasks'),('tasks:create','Create or dispatch movement tasks'),('tasks:complete','Confirm assigned movement tasks'),
('gate:in','Register inbound gate visits'),('gate:out','Confirm outbound gate visits'),('holds:write','Place inspection or security holds'),('holds:release','Release holds with authority'),
('inspections:write','Record container inspection results'),('reports:read','Read operational and billing reports'),('reports:export','Export billing or operational reports'),
('audit:read','Read audit history'),('users:manage','Create and manage user accounts'),('roles:manage','Manage roles and permissions'),('system:manage','Manage system configuration and health'),('partner:read','Read restricted partner records');

INSERT IGNORE INTO role_permissions (role_name,permission_code)
SELECT r.role_name,p.permission_code FROM roles r CROSS JOIN permissions p WHERE r.role_name='System Administrator';
INSERT IGNORE INTO role_permissions VALUES
('ICD Operations Manager','dashboard:read'),('ICD Operations Manager','containers:read'),('ICD Operations Manager','yard:read'),('ICD Operations Manager','yard:plan'),('ICD Operations Manager','tasks:read'),('ICD Operations Manager','tasks:create'),('ICD Operations Manager','tasks:complete'),('ICD Operations Manager','gate:in'),('ICD Operations Manager','gate:out'),('ICD Operations Manager','holds:release'),('ICD Operations Manager','inspections:write'),('ICD Operations Manager','reports:read'),('ICD Operations Manager','reports:export'),('ICD Operations Manager','audit:read'),('ICD Operations Manager','system:manage'),
('Gate Operator','containers:read'),('Gate Operator','gate:in'),('Gate Operator','gate:out'),('Gate Operator','inspections:write'),('Gate Operator','reports:read'),
('Yard Planner / Yard Controller','dashboard:read'),('Yard Planner / Yard Controller','containers:read'),('Yard Planner / Yard Controller','containers:write'),('Yard Planner / Yard Controller','yard:read'),('Yard Planner / Yard Controller','yard:plan'),('Yard Planner / Yard Controller','tasks:read'),('Yard Planner / Yard Controller','tasks:create'),('Yard Planner / Yard Controller','tasks:complete'),('Yard Planner / Yard Controller','holds:write'),('Yard Planner / Yard Controller','reports:read'),
('Reach-Stacker Operator','tasks:read'),('Reach-Stacker Operator','tasks:complete'),('Reach-Stacker Operator','yard:read'),
('Inspection / Security','containers:read'),('Inspection / Security','yard:read'),('Inspection / Security','inspections:write'),('Inspection / Security','holds:write'),('Inspection / Security','reports:read'),
('Billing / Finance','containers:read'),('Billing / Finance','reports:read'),('Billing / Finance','reports:export'),
('Auditor / Management','dashboard:read'),('Auditor / Management','containers:read'),('Auditor / Management','yard:read'),('Auditor / Management','tasks:read'),('Auditor / Management','reports:read'),('Auditor / Management','audit:read'),
('External Partner','partner:read');

INSERT IGNORE INTO role_permissions (role_name,permission_code)
SELECT role_name,'dashboard:read' FROM roles WHERE role_name IN ('Gate Operator','Yard Planner / Yard Controller','Reach-Stacker Operator','Inspection / Security','Billing / Finance','Auditor / Management');
