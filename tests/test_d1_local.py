"""Local SQLite behavioral tests. NOT Cloudflare production, NOT an OCR accuracy test."""
import sqlite3
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
INIT = (ROOT / 'migrations' / '0001_init.sql').read_text()
INDEXES = (ROOT / 'migrations' / '0002_indexes.sql').read_text()
GUARDS = (ROOT / 'migrations' / '0005_single_household.sql').read_text()
VERSIONS = (ROOT / 'migrations' / '0006_document_version.sql').read_text()
NOW = '2026-11-11T00:00:00Z'


def conn():
    db=sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript(INIT)
    db.executescript(INDEXES)
    db.executescript(GUARDS)
    db.executescript(VERSIONS)
    return db


def seed(db):
    db.execute('INSERT INTO households VALUES(?,?,?,?)', ('h1','家',NOW,NOW))
    for uid,role in [('u1','owner'),('u2','member')]:
        db.execute('INSERT INTO users(id,household_id,email_norm,role,created_at,updated_at) VALUES(?,?,?,?,?,?)',(uid,'h1',uid+'@example.invalid',role,NOW,NOW))
    db.execute('INSERT INTO documents(id,owner_id,household_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)',('d1','u1','h1','給与',NOW,NOW))
    db.execute('INSERT INTO documents(id,owner_id,household_id,title,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',('d2','u2','h1','共用','shared',NOW,NOW))
    db.commit()

class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.db=conn()
        seed(self.db)
    def tearDown(self):
        self.db.close()
    def test_document_source_date_does_not_imply_official_verification(self):
        before=self.db.execute("SELECT source_document_date,official_current_verified_at FROM documents WHERE id='d1'").fetchone()
        self.assertEqual(before,(None,None))
        self.db.execute("UPDATE documents SET source_document_date=? WHERE id='d1'",('2026-11-11',))
        after=self.db.execute("SELECT source_document_date,official_current_verified_at FROM documents WHERE id='d1'").fetchone()
        self.assertEqual(after,('2026-11-11',None))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE documents SET source_document_date=? WHERE id='d1'",('not-a-date',))

    def test_one_household_only(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT INTO households VALUES(?,?,?,?)',('h2','other',NOW,NOW))
    def test_no_third_household_user(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',('u3','h1','u3@example.invalid','third','member','active',NOW,NOW))
    def test_default_private(self):
        a=self.db.execute("SELECT visibility,lifecycle FROM documents WHERE id='d1'").fetchone()
        self.assertEqual(a,('private','active'))
        accessible=self.db.execute('SELECT id FROM documents WHERE lifecycle=? AND (owner_id=? OR (household_id=? AND visibility=?))',('active','u2','h1','shared')).fetchall()
        self.assertEqual(accessible,[('d2',)])
    def test_object_owner_different_user_rejected(self):
        self.db.execute('INSERT INTO storage_objects(id,owner_id,bucket,object_key,sha256,bytes,mime,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',('o1','u1','private','u1/x','h1',128,'image/webp','ready',NOW,NOW))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT INTO attachments(id,document_id,object_id,created_at,updated_at) VALUES(?,?,?,?,?)',('a1','d2','o1',NOW,NOW))
        self.db.execute('INSERT INTO attachments(id,document_id,object_id,created_at,updated_at) VALUES(?,?,?,?,?)',('a2','d1','o1',NOW,NOW))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE storage_objects SET owner_id='u2' WHERE id='o1'")
    def test_trashed_doc_is_not_accessible_in_normal_list(self):
        self.db.execute('UPDATE documents SET lifecycle=?,trashed_at=? WHERE id=?',('trashed',NOW,'d1'))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM documents WHERE lifecycle='active' AND owner_id='u1'").fetchone()[0],0)
        self.db.execute('UPDATE documents SET lifecycle=?,trashed_at=NULL WHERE id=?',('active','d1'))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM documents WHERE lifecycle='active' AND owner_id='u1'").fetchone()[0],1)
    def test_dedupe_integration_link(self):
        self.db.execute('INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',('c1','d1','finance','{"amount_jpy":3000}',NOW,NOW))
        sql='INSERT INTO integration_links(id,candidate_id,target,idempotency_key,updated_at) VALUES(?,?,?,?,?)'
        self.db.execute(sql,('i1','c1','kakebo','k1',NOW))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute(sql,('i2','c1','kakebo','k2',NOW))
    def test_do_not_delete_shared_object_while_referenced(self):
        self.db.execute('INSERT INTO documents(id,owner_id,household_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)',('d3','u1','h1','copy',NOW,NOW))
        self.db.execute('INSERT INTO storage_objects(id,owner_id,bucket,object_key,sha256,bytes,mime,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',('o1','u1','private','u1/x','h1',128,'image/webp','ready',NOW,NOW))
        for aid,did in [('a1','d1'),('a2','d3')]:
            self.db.execute('INSERT INTO attachments(id,document_id,object_id,created_at,updated_at) VALUES(?,?,?,?,?)',(aid,did,'o1',NOW,NOW))
        # Soft-deleting one doc MUST NOT cause R2.delete: the other reference remains.
        self.db.execute('UPDATE documents SET lifecycle=?,trashed_at=? WHERE id=?',('trashed',NOW,'d1'))
        count=self.db.execute("SELECT COUNT(*) FROM attachments a JOIN documents d ON a.document_id=d.id WHERE a.object_id=? AND d.lifecycle!='deletion_pending' AND a.state!='deletion_pending'",('o1',)).fetchone()[0]
        self.assertEqual(count,2)
        self.db.execute("UPDATE documents SET lifecycle='deletion_pending' WHERE id='d1'")
        count=self.db.execute("SELECT COUNT(*) FROM attachments a JOIN documents d ON a.document_id=d.id WHERE a.object_id=? AND d.lifecycle!='deletion_pending' AND a.state!='deletion_pending'",('o1',)).fetchone()[0]
        self.assertEqual(count,1)
    def test_source_field_provenance(self):
        self.db.execute('INSERT INTO document_fields(id,document_id,field_key,normalized_value,source_quote,review_state,updated_at) VALUES(?,?,?,?,?,?,?)',('f1','d1','net_salary','250000','差引支給額 250,000円','unreviewed',NOW))
        self.assertEqual(self.db.execute('SELECT review_state FROM document_fields WHERE id=?',('f1',)).fetchone()[0],'unreviewed')

if __name__=='__main__': unittest.main(verbosity=2)
