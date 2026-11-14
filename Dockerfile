FROM python:3.12-slim
WORKDIR /app
COPY server.py update_data.py ./
COPY public ./public
RUN useradd --create-home appuser && chown -R appuser:appuser /app
USER appuser
ENV PORT=3080
EXPOSE 3080
CMD ["python", "server.py", "--host", "0.0.0.0"]
