export function getHealth(req, res) {
  res.status(200).json({
    success: true,
    message: 'Traffic management backend is running',
    data: {
      service: 'traffic-management-api',
      status: 'healthy',
    },
    timestamp: new Date().toISOString(),
  });
}
