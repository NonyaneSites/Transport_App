import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';

const SECRET_CODE = import.meta.env.VITE_APPROVAL_SECRET || '230825';

export function ApprovalPage() {
  const [accessCode, setAccessCode] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [pendingUsers, setPendingUsers] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      fetchPendingUsers();
    }
  }, [isAuthenticated]);

  function handleAuth(e) {
    e.preventDefault();
    if (accessCode === SECRET_CODE) {
      setIsAuthenticated(true);
    } else {
      alert("Invalid Access Code");
    }
  }

  async function fetchPendingUsers() {
    setLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('status', 'pending');
      
    if (data) setPendingUsers(data);
    setLoading(false);
  }

  async function handleAction(userId, action) {
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    
    const { error } = await supabase
      .from('profiles')
      .update({ status: newStatus })
      .eq('id', userId);

    if (!error) {
      setPendingUsers(pendingUsers.filter(u => u.id !== userId));
    } else {
      alert("Error updating user status");
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
        <form onSubmit={handleAuth} className="max-w-sm w-full bg-white p-6 rounded-lg shadow-xl">
          <h2 className="text-xl font-bold mb-4 text-center">Admin Access Required</h2>
          <input
            type="password"
            placeholder="Enter Secret Code"
            className="w-full px-4 py-2 border rounded-md mb-4 focus:ring-2 focus:ring-gray-900"
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
          />
          <button type="submit" className="w-full bg-gray-900 text-white py-2 rounded-md hover:bg-gray-800">
            Enter
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Pending Account Approvals</h1>
        
        {loading ? (
          <p>Loading pending accounts...</p>
        ) : pendingUsers.length === 0 ? (
          <div className="bg-white p-6 rounded-lg shadow text-center text-gray-500">
            No pending accounts to approve.
          </div>
        ) : (
          <div className="bg-white shadow overflow-hidden sm:rounded-md">
            <ul className="divide-y divide-gray-200">
              {pendingUsers.map((user) => (
                <li key={user.id} className="px-6 py-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{user.email}</p>
                    <p className="text-sm text-gray-500">Requested on: {new Date(user.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="flex space-x-3">
                    <button
                      onClick={() => handleAction(user.id, 'reject')}
                      className="px-4 py-2 text-sm font-medium text-red-600 bg-red-100 rounded-md hover:bg-red-200"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => handleAction(user.id, 'approve')}
                      className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700"
                    >
                      Approve
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}