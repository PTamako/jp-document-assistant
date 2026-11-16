import sqlite3
import unittest
from pathlib import Path

MIGRATION = (Path(__file__).resolve().parents[1] / "migrations"
             / "0020_homeflow_identity_links.sql").read_text("utf-8")

class HomeFlowIdentityLinkMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE households (id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE users (
              id TEXT PRIMARY KEY, household_id TEXT NOT NULL
                REFERENCES households(id), role TEXT NOT NULL,
              email_norm TEXT NOT NULL UNIQUE);
            CREATE TABLE documents (
              id TEXT PRIMARY KEY, owner_id TEXT NOT NULL
                REFERENCES users(id), title TEXT);
            CREATE TABLE google_oauth_grants (
              user_id TEXT PRIMARY KEY REFERENCES users(id),
              ciphertext TEXT NOT NULL);
            INSERT INTO households VALUES('legacy-hh','existing household');
            INSERT INTO users VALUES
              ('legacy-owner','legacy-hh','owner','existing@example.invalid');
            INSERT INTO documents VALUES('existing-doc','legacy-owner','private');
            INSERT INTO google_oauth_grants VALUES('legacy-owner','opaque-ciphertext');
        """)

    def tearDown(self):
        self.db.close()

    def test_additive_no_seed_no_existing_data_change(self):
        self.db.executescript(MIGRATION)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM homeflow_identity_links")
              .fetchone()[0], 0)
        self.assertEqual(
            self.db.execute("SELECT owner_id FROM documents WHERE id='existing-doc'")
              .fetchone()[0], "legacy-owner")
        self.assertEqual(
            self.db.execute("SELECT ciphertext FROM google_oauth_grants")
              .fetchone()[0], "opaque-ciphertext")
        self.db.executescript(MIGRATION)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM homeflow_identity_links")
              .fetchone()[0], 0)

    def test_unique_one_to_one_link_and_stable_user(self):
        self.db.executescript(MIGRATION)
        self.db.execute("""
          INSERT INTO homeflow_identity_links
           (homeflow_user_id,homeflow_household_id,local_user_id,verified_at)
          VALUES ('hf-owner','hf-household','legacy-owner','2026-11-13T00:00:00Z')
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
              INSERT INTO homeflow_identity_links
               (homeflow_user_id,homeflow_household_id,local_user_id,verified_at)
              VALUES ('another-hf-user','hf-household','legacy-owner','2026-11-13')
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
              INSERT INTO homeflow_identity_links
               (homeflow_user_id,homeflow_household_id,local_user_id,verified_at)
              VALUES ('hf-member','hf-household','missing-local-user','2026-11-13')
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
              UPDATE homeflow_identity_links SET homeflow_user_id='imposter'
              WHERE homeflow_user_id='hf-owner'
            """)
        self.assertEqual(
            self.db.execute("SELECT local_user_id FROM homeflow_identity_links"
                            " WHERE homeflow_user_id='hf-owner'").fetchone()[0],
            "legacy-owner")

    def test_member_new_local_space_is_empty_and_does_not_inherit_grants(self):
        self.db.executescript(MIGRATION)
        self.db.execute("""
          INSERT INTO users VALUES
          ('new-local-member','legacy-hh','member','sso-member@example.invalid')
        """)
        self.db.execute("""
          INSERT INTO homeflow_identity_links
            (homeflow_user_id,homeflow_household_id,local_user_id,verified_at)
          VALUES('hf-member','hf-household','new-local-member','2026-11-13')
        """)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM documents"
                            " WHERE owner_id='new-local-member'").fetchone()[0],0)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM google_oauth_grants"
                            " WHERE user_id='new-local-member'").fetchone()[0],0)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM documents"
                            " WHERE owner_id='legacy-owner'").fetchone()[0],1)

if __name__ == "__main__":
    unittest.main()
