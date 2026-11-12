"""Contract guard without third-party pip dependency in GitHub CI.

Parse only the OpenAPI sections needed to detect route and operation-ID drift.
The full YAML file is also checked with PyYAML locally when it is available.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = (ROOT/'openapi.yaml').read_text(encoding='utf-8')
WORKER = (ROOT/'worker/index.js').read_text(encoding='utf-8')

class OpenApiContractTests(unittest.TestCase):
    def test_only_actual_v011_routes_are_documented(self):
        self.assertIn('openapi: 3.1.0', SPEC)
        self.assertEqual(SPEC.count('\ncomponents:\n'),1)
        self.assertNotIn('\n}\n      responses:',SPEC)
        paths = re.findall(r'^  (/api/[^:\n]+):\s*$', SPEC, re.M)
        self.assertEqual(len(paths),56)
        self.assertEqual(len(paths),len(set(paths)))
        self.assertNotIn('/api/auth/start',paths)
        self.assertNotIn('/api/auth/complete',paths)
        self.assertNotIn('/api/connections/{provider}/authorize',paths)
        for name in ['/api/auth/bootstrap','/api/auth/login','/api/auth/change-password','/api/calendar/{token}.ics','/api/calendar/revoke','/api/household/join',
                     '/api/documents/{documentId}/attachments/{attachmentId}/permanent-delete',
                     '/api/storage/cleanup-orphans','/api/backups/import-confirm',
                     '/api/documents/{documentId}/attachments/order', '/api/documents/{documentId}/reinterpret', '/api/documents/{documentId}/manual-income']:
            self.assertIn(name,paths)
        self.assertIn("path==='/api/storage/cleanup-orphans'",WORKER)
        self.assertIn("path==='/api/auth/bootstrap'",WORKER)
        self.assertIn('cleanupOrphans(env,p)',WORKER)
        for endpoint in ['/api/auth/sessions','/api/auth/sessions/revoke','/api/auth/sessions/revoke-others']:
            self.assertIn(endpoint,paths)
            self.assertIn("path==='"+endpoint+"'",WORKER)

    def test_operations_are_unique_and_security_boundary_documented(self):
        operations = re.findall(r'^    (get|post|patch|put|delete):\s*$', SPEC, re.M)
        ids=re.findall(r'^      operationId:\s*(\S+)\s*$',SPEC,re.M)
        self.assertEqual(len(operations),57)
        self.assertEqual(len(ids),56)
        self.assertEqual(len(ids),len(set(ids)))
        for operation in ['listOwnSessions','revokeOwnSession','revokeOtherOwnSessions','reinterpretDocumentPreservingReview','createConfirmedManualSalaryIncome']:
            self.assertIn(operation,ids)
        self.assertIn('X-CSRF-Token',SPEC)
        self.assertIn('Idempotency-Key',SPEC)
        self.assertIn('DELETE_FOREVER',SPEC)
        self.assertIn('SHA-256',SPEC)
        self.assertIn('尚未正式部署',SPEC)

if __name__=='__main__':
    unittest.main()
