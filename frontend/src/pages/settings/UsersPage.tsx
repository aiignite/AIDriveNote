import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Pencil, RefreshCw, Search, Users } from 'lucide-react';
import { adminUsersApi, type AdminUser, type AdminUserUpdate } from '../../services/admin/users';
import { UserEditForm } from '../../components/admin/UserEditForm';

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

const RoleBadge: React.FC<{ role: string }> = ({ role }) => (
  <span
    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
      role === 'admin'
        ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
    }`}
  >
    {role === 'admin' ? '管理员' : '普通用户'}
  </span>
);

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span
    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
      status === 'Active'
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
        : 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
    }`}
  >
    {status === 'Active' ? '启用' : '禁用'}
  </span>
);

const UsersPage: React.FC = () => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const deferredSearch = useDeferredValue(searchTerm);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminUsersApi.listUsers({
        q: deferredSearch.trim() || undefined,
        role: roleFilter === 'all' ? undefined : roleFilter,
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 100,
      });
      setUsers(data.items);
      setTotal(data.total);
    } catch (error) {
      console.error('Failed to load users:', error);
      toast.error('加载用户列表失败');
    } finally {
      setLoading(false);
    }
  }, [deferredSearch, roleFilter, statusFilter]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const handleSave = useCallback(
    async (data: AdminUserUpdate) => {
      if (!editingUser) return;
      try {
        await adminUsersApi.updateUser(editingUser.id, data);
        toast.success('用户信息已更新');
        setEditingUser(null);
        await loadUsers();
      } catch (error) {
        const msg = error instanceof Error ? error.message : '保存失败';
        toast.error(msg);
        throw error;
      }
    },
    [editingUser, loadUsers],
  );

  const summary = useMemo(
    () => `${users.length} / ${total} 个用户`,
    [users.length, total],
  );

  return (
    <div className="h-full min-h-0 overflow-auto bg-slate-50 dark:bg-gray-950 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 shadow-lg shadow-indigo-500/20">
                  <Users className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">用户管理</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    查看并管理用户姓名、状态与角色
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadUsers()}
                className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                title="刷新"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 p-4 dark:border-gray-700">
            <div className="relative min-w-[200px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                placeholder="搜索邮箱或姓名…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="all">全部角色</option>
              <option value="admin">管理员</option>
              <option value="user">普通用户</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="all">全部状态</option>
              <option value="Active">启用</option>
              <option value="Inactive">禁用</option>
            </select>
            <span className="text-xs text-gray-400">{summary}</span>
          </div>

          {loading ? (
            <div className="p-8 text-center text-sm text-gray-400">加载中…</div>
          ) : users.length === 0 ? (
            <div className="m-4 rounded-xl border border-dashed border-gray-200 p-12 text-center dark:border-gray-700">
              <Users className="mx-auto mb-3 h-10 w-10 text-gray-300 dark:text-gray-600" />
              <p className="text-sm text-gray-500 dark:text-gray-400">暂无匹配的用户</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="px-4 py-3 font-medium">邮箱</th>
                    <th className="px-4 py-3 font-medium">姓名</th>
                    <th className="px-4 py-3 font-medium">角色</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">注册时间</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr
                      key={user.id}
                      className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900/50"
                    >
                      <td className="px-4 py-3 text-gray-900 dark:text-gray-100">{user.email}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{user.name}</td>
                      <td className="px-4 py-3">
                        <RoleBadge role={user.role} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={user.status} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {formatDate(user.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setEditingUser(user)}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-950 dark:hover:text-indigo-400"
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editingUser && (
        <UserEditForm
          user={editingUser}
          onSave={handleSave}
          onClose={() => setEditingUser(null)}
        />
      )}
    </div>
  );
};

export default UsersPage;
