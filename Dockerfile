FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY tradeaudit.py proxy.py ./
VOLUME /app/audit_data
EXPOSE 8877
ENTRYPOINT ["python", "proxy.py"]
