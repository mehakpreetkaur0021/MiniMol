function errorHandler(error, req, res, next) {
  const statusCode = error.statusCode || error.status || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    console.error(error);
  }

  res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 ? 'An unexpected server error occurred' : error.message,
    ...(isProduction ? {} : { details: statusCode >= 500 ? error.message : undefined }),
  });
}

export default errorHandler;
