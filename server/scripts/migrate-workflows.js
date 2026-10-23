require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../src/db');

const columns = {
  containers: {
    cargo_status: "ENUM('LOADED','EMPTY') NOT NULL DEFAULT 'LOADED'",
    condition_status: "VARCHAR(40) NOT NULL DEFAULT 'UNKNOWN'",
    cargo_classification: "ENUM('IMPORT','EXPORT','TRANSHIPMENT','DOMESTIC') NOT NULL DEFAULT 'IMPORT'",
    booking_ref: 'VARCHAR(100) NULL',
    customs_status: "VARCHAR(40) NOT NULL DEFAULT 'UNKNOWN'",
    commercial_status: "VARCHAR(40) NOT NULL DEFAULT 'UNKNOWN'",
    inspection_status: "VARCHAR(40) NOT NULL DEFAULT 'NOT_REQUIRED'",
    planned_destination_location_id: 'BIGINT UNSIGNED NULL',
    last_movement_at: 'DATETIME NULL',
  },
  visits: {
    manifest_id: 'BIGINT UNSIGNED NULL',
    exception_id: 'BIGINT UNSIGNED NULL',
    gate_out_reference: 'VARCHAR(100) NULL', handover_evidence: 'VARCHAR(500) NULL', receipt_reference: 'VARCHAR(100) NULL',
  },
  inspections: { visit_id: 'BIGINT UNSIGNED NULL', damage_category: 'VARCHAR(80) NULL', evidence_refs: 'JSON NULL', follow_up: 'VARCHAR(500) NULL' },
  yard_locations: {
    length_m: 'DECIMAL(8,2) NULL', width_m: 'DECIMAL(8,2) NULL', height_m: 'DECIMAL(8,2) NULL',
    capacity_kg: 'DECIMAL(10,2) NULL', max_stack_tier: 'TINYINT UNSIGNED NULL',
    availability_status: "ENUM('AVAILABLE','BLOCKED','MAINTENANCE','RETIRED') NOT NULL DEFAULT 'AVAILABLE'",
    storage_zone: 'VARCHAR(40) NULL', handling_access: 'VARCHAR(40) NULL', operational_group: 'VARCHAR(40) NULL', gate_distance_m: 'DECIMAL(8,2) NULL', reservation_expires_at: 'DATETIME NULL',
  },
  movement_tasks: { picked_up_at: 'DATETIME NULL', pickup_confirmed_by: 'VARCHAR(254) NULL', allocation_override_reason: 'VARCHAR(500) NULL', allocation_override_approved_by: 'VARCHAR(254) NULL' },
};

const tables = [
  `CREATE TABLE IF NOT EXISTS depots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, depot_code VARCHAR(30) NOT NULL UNIQUE,
    depot_name VARCHAR(160) NOT NULL, address VARCHAR(500), time_zone VARCHAR(80) NOT NULL DEFAULT 'UTC',
    is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS master_data (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, data_type VARCHAR(40) NOT NULL,
    code VARCHAR(80) NOT NULL, label VARCHAR(160) NOT NULL, description VARCHAR(500), metadata JSON NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_master_type_code(data_type,code), KEY idx_master_search(data_type,is_active,label)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS operational_rules (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, rule_code VARCHAR(80) NOT NULL UNIQUE,
    label VARCHAR(160) NOT NULL, value_json JSON NOT NULL, description VARCHAR(500),
    is_active BOOLEAN NOT NULL DEFAULT TRUE, updated_by VARCHAR(120), updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS manifests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, reference_code VARCHAR(100) NOT NULL UNIQUE,
    customer VARCHAR(160), shipping_line VARCHAR(100), direction ENUM('INBOUND','OUTBOUND','IMPORT','EXPORT','TRANSHIPMENT','DOMESTIC') NOT NULL DEFAULT 'INBOUND',
    expected_arrival_at DATETIME NULL, expected_departure_at DATETIME NULL,
    status ENUM('DRAFT','SUBMITTED','APPROVED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED','EXCEPTION') NOT NULL DEFAULT 'DRAFT',
    document_ref VARCHAR(500), notes VARCHAR(1000), created_by VARCHAR(254), updated_by VARCHAR(254),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_manifest_status_eta(status,expected_arrival_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS manifest_containers (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, manifest_id BIGINT UNSIGNED NOT NULL,
    container_id BIGINT UNSIGNED NULL, container_number VARCHAR(20) NOT NULL,
    booking_ref VARCHAR(100), iso_size VARCHAR(8), cargo_status ENUM('LOADED','EMPTY') NULL,
    expected_arrival_at DATETIME NULL, expected_departure_at DATETIME NULL,
    status ENUM('EXPECTED','RECEIVED','CANCELLED','EXCEPTION_APPROVED') NOT NULL DEFAULT 'EXPECTED',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_manifest_container(manifest_id,container_number),
    CONSTRAINT fk_manifest_line_manifest FOREIGN KEY(manifest_id) REFERENCES manifests(id),
    CONSTRAINT fk_manifest_line_container FOREIGN KEY(container_id) REFERENCES containers(id) ON DELETE SET NULL,
    KEY idx_manifest_line_status(status,container_number)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS manifest_exceptions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, container_id BIGINT UNSIGNED NULL,
    container_number VARCHAR(20) NOT NULL, manifest_id BIGINT UNSIGNED NULL, visit_id BIGINT UNSIGNED NULL,
    reason VARCHAR(500) NOT NULL, status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
    requested_by VARCHAR(254) NOT NULL, reviewed_by VARCHAR(254), review_reason VARCHAR(500),
    requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at DATETIME NULL,
    CONSTRAINT fk_exception_container FOREIGN KEY(container_id) REFERENCES containers(id) ON DELETE SET NULL,
    CONSTRAINT fk_exception_manifest FOREIGN KEY(manifest_id) REFERENCES manifests(id) ON DELETE SET NULL,
    KEY idx_manifest_exception(status,requested_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS container_documents (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, container_id BIGINT UNSIGNED NOT NULL,
    document_type VARCHAR(40) NOT NULL, file_name VARCHAR(255) NOT NULL, uri VARCHAR(1000) NOT NULL,
    content_type VARCHAR(120), uploaded_by VARCHAR(254), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_container_document FOREIGN KEY(container_id) REFERENCES containers(id),
    KEY idx_container_document(container_id,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS reconciliation_discrepancies (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, container_id BIGINT UNSIGNED NULL, container_number VARCHAR(20) NOT NULL,
    category VARCHAR(80) NOT NULL, description VARCHAR(500) NOT NULL,
    status ENUM('OPEN','RESOLVED','WAIVED') NOT NULL DEFAULT 'OPEN', detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL, resolved_by VARCHAR(254),
    CONSTRAINT fk_recon_container FOREIGN KEY(container_id) REFERENCES containers(id) ON DELETE SET NULL,
    KEY idx_recon_status(status,detected_at)
  ) ENGINE=InnoDB`,
];

async function main() {
  for (const [table, defs] of Object.entries(columns)) {
    const [existing] = await pool.query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]);
    const names = new Set(existing.map(col => col.COLUMN_NAME));
    for (const [name, definition] of Object.entries(defs)) {
      if (!names.has(name)) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`);
    }
  }
  for (const sql of tables) await pool.query(sql);
  await pool.query("ALTER TABLE movement_tasks MODIFY task_type ENUM('PUTAWAY','RETRIEVAL','RELOCATION','REHANDLE','YARD_CORRECTION') NOT NULL, MODIFY status ENUM('QUEUED','ASSIGNED','IN_PROGRESS','PICKUP_CONFIRMED','COMPLETED','EXCEPTION','BLOCKED','FAILED','AWAITING_APPROVAL','CANCELLED') NOT NULL DEFAULT 'QUEUED'");
  await pool.query("ALTER TABLE containers MODIFY hold_status ENUM('CLEAR','CUSTOMS','COMMERCIAL','SECURITY','INSPECTION','DOCUMENTATION','DAMAGE') NOT NULL DEFAULT 'CLEAR'");
  await pool.query(`CREATE TABLE IF NOT EXISTS movement_task_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, task_id BIGINT UNSIGNED NOT NULL,
    event_type VARCHAR(40) NOT NULL, actor VARCHAR(254) NOT NULL, detail VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_task_event_task FOREIGN KEY(task_id) REFERENCES movement_tasks(id), KEY idx_task_event(task_id,created_at)
  ) ENGINE=InnoDB`);
  const [[depotFk]] = await pool.query("SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='yard_locations' AND CONSTRAINT_NAME='fk_yard_location_depot'");
  if (!depotFk) await pool.query('ALTER TABLE yard_locations ADD CONSTRAINT fk_yard_location_depot FOREIGN KEY (depot_code) REFERENCES depots(depot_code) ON UPDATE CASCADE ON DELETE RESTRICT');
  await pool.query(`INSERT IGNORE INTO permissions(permission_code,description) VALUES
    ('manifest:read','View manifests and expected arrivals'),('manifest:manage','Create and update manifests'),('manifest:approve','Approve unexpected arrival exceptions'),
    ('master:read','View reference and master data'),('master:manage','Manage reference and master data')`);
  await pool.query(`INSERT IGNORE INTO role_permissions(role_name,permission_code) VALUES
    ('System Administrator','manifest:read'),('System Administrator','manifest:manage'),('System Administrator','manifest:approve'),('System Administrator','master:read'),('System Administrator','master:manage'),
    ('ICD Operations Manager','manifest:read'),('ICD Operations Manager','manifest:manage'),('ICD Operations Manager','manifest:approve'),('ICD Operations Manager','master:read'),('ICD Operations Manager','master:manage'),
    ('Gate Operator','manifest:read'),('Gate Operator','master:read'),
    ('Yard Planner / Yard Controller','manifest:read'),('Yard Planner / Yard Controller','manifest:manage'),('Yard Planner / Yard Controller','master:read'),('Yard Planner / Yard Controller','master:manage'),
    ('Reach-Stacker Operator','manifest:read'),('Inspection / Security','manifest:read'),('Billing / Finance','manifest:read'),('Auditor / Management','manifest:read')`);
  await pool.query(`INSERT IGNORE INTO operational_rules(rule_code,label,value_json,description) VALUES
    ('dwell_warning_hours','Dwell warning threshold (hours)','120','Hours in yard before a container appears in the dwell warning KPI.'),
    ('dwell_critical_hours','Critical dwell threshold (hours)','240','Hours in yard before a container is raised as critical.'),
    ('movement_overdue_minutes','Movement task overdue threshold (minutes)','60','Age of an unfinished movement task before it is reported overdue.'),
    ('yard_max_stack_tier','Default approved maximum stack tier','1','Conservative site-level maximum. A location-specific max_stack_tier may lower or raise this only when approved.'),
    ('yard_reservation_minutes','Yard slot reservation lifetime (minutes)','120','How long an unused destination reservation remains valid.'),
    ('yard_allocation_weights','Slot recommendation priorities','{\"tier\":10,\"same_block\":8,\"access\":4,\"gate_distance\":1}','Relative score weights used to explain and rank compatible slots.'),
    ('yard_hold_zone_map','Hold category to approved storage zone map','{}','Map hold categories to site-approved yard storage_zone values.'),
    ('yard_allocation_override_requires_supervisor','Require supervisor approval for allocation overrides','true','Only non-safety operational-group preferences may be overridden, with a separate authorised supervisor when enabled.')`);
  await pool.query(`INSERT IGNORE INTO operational_rules(rule_code,label,value_json,description) VALUES
    ('gateout_require_documents','Require at least one supporting document for gate-out','false','When enabled, a container must have an associated document before gate-out.'),
    ('gateout_require_clearance','Require explicit clearance status for gate-out','false','When enabled, customs and commercial statuses must both be CLEAR.')`);
  const [depots] = await pool.query('SELECT id FROM depots WHERE depot_code=?', ['CHN-ICD']);
  if (!depots.length) await pool.query('INSERT INTO depots(depot_code,depot_name,time_zone) VALUES (?,?,?)', ['CHN-ICD','Chennai ICD','Asia/Kolkata']);
  process.stdout.write('Workflow, container, manifest, master-data and document tables are ready.\n');
}

main().catch(error => { process.stderr.write(`Migration failed: ${error.message}\n`); process.exitCode = 1; }).finally(() => pool.end());
